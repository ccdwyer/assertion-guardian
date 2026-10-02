import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Blocked } from '../types'
import { applyEdit, bashSignals, isTestFile, notebookChange, weakening } from './analyze'

const blocked = atom({ plugin: 'assertion-guardian', key: 'blocked' } as const, null)
const allowed = atom({ plugin: 'assertion-guardian', key: 'allowed' } as const, [])

const COSMETIC = new Set(['tool_use_id', 'agentId', 'consent', 'description'])

async function fingerprint(e: { tool: string; [k: string]: unknown }): Promise<string> {
  const args = Object.keys(e)
    .filter(k => !COSMETIC.has(k))
    .sort()
    .map(k => [k, e[k]])
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(args)))
  return [...new Uint8Array(bytes).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The file's current text; if it is missing, what git last committed for it,
// so deleting a test and writing a weaker one from scratch is still compared.
// `null`: there is no earlier version anywhere (a genuinely new file).
// Throws when the file exists but cannot be read, or git's answer cannot be
// trusted, so the caller fails closed.
async function previous($: EngineInterface, path: string): Promise<string | null> {
  if (await $.fs.exists(path)) return $.fs.read(path)
  // Run git from the nearest folder that still exists (the test's own folder
  // may have been deleted with it).
  let dir = path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '.'
  while (dir.includes('/') && !(await $.fs.exists(dir))) dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  if (top.exitCode !== 0) {
    // Not a git repository: nothing to compare with. Any other failure
    // (timeout, safe.directory) cannot vouch that the file is new.
    if (/not a git repository/i.test(top.stderr)) return null
    throw new Error(`git rev-parse failed: ${top.stderr.slice(0, 200)}`)
  }
  const root = top.stdout.trim()
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const shown = await $.process.run(['git', '-C', root, 'show', `HEAD:${relative}`], { timeoutMs: 5000 })
  if (shown.exitCode === 0) {
    if (shown.isStdoutTruncated) throw new Error('baseline truncated')
    return shown.stdout
  }
  // Never committed (or no commits yet): a genuinely new file.
  if (/does not exist|exists on disk, but not in|invalid object name|bad revision|unknown revision/i.test(shown.stderr)) return null
  throw new Error(`git show failed: ${shown.stderr.slice(0, 200)}`)
}

async function check($: EngineInterface, e: { tool: string; [k: string]: unknown }): Promise<{ target: string; signals: string[] } | null> {
  const unreadable = (target: string) => ({ target, signals: [`the earlier version of ${target} could not be read, so the change cannot be checked`] })

  if (e.tool === 'Bash') {
    const signals = bashSignals(String(e.command ?? ''))
    return signals.length > 0 ? { target: 'shell command', signals } : null
  }
  if (e.tool === 'Edit' || e.tool === 'Write') {
    const target = String(e.file_path)
    if (!isTestFile(target)) return null
    let before: string | null
    try {
      before = await previous($, target)
    } catch {
      return unreadable(target)
    }
    if (e.tool === 'Write') return { target, signals: weakening(before ?? '', String(e.content), target) }
    if (before === null) return { target, signals: weakening(String(e.old_string), String(e.new_string), target) }
    const after = applyEdit(before, String(e.old_string), String(e.new_string), e.replace_all === true)
    // old_string is not in the file: the tool will fail on its own.
    return after === null ? null : { target, signals: weakening(before, after, target) }
  }
  if (e.tool === 'NotebookEdit') {
    const target = String(e.notebook_path)
    if (!isTestFile(target)) return null
    let notebook: string | null
    try {
      notebook = await previous($, target)
    } catch {
      return unreadable(target)
    }
    const change = notebookChange(notebook ?? '', target, {
      cell_id: typeof e.cell_id === 'string' ? e.cell_id : undefined,
      new_source: String(e.new_source ?? ''),
      edit_mode: typeof e.edit_mode === 'string' ? e.edit_mode : undefined,
      cell_type: typeof e.cell_type === 'string' ? e.cell_type : undefined,
    })
    if (change === 'skip') return null
    if (change === null) return { target, signals: [`the cell this edit names is not in ${target}, so the change cannot be checked`] }
    return { target, signals: weakening(change.before, change.after, change.as) }
  }
  return null
}

function refusal(target: string, signals: string[]): string {
  return (
    `Assertion Guardian: refused a change that weakens tests (${target}):\n` +
    signals.map(s => `  - ${s}`).join('\n') +
    `\nFix the code under test so the existing tests pass; do not make the tests easier to pass. ` +
    `If you believe the test itself is wrong (the spec changed, the assertion was buggy), stop and ` +
    `ask the user, explaining exactly why. The user can allow this exact change once with ` +
    `/allow-test-change; then retry the identical call.`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'allow-test-change',
      description: 'Assertion Guardian: allow the last blocked test change, exactly as proposed, once',
      argumentHint: '[file]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'allow-test-change' }, async ($, e) => {
    const last = await read($, blocked)
    if (last === null) return { text: 'Assertion Guardian: nothing is blocked right now.' }
    const named = e.args.trim()
    if (named !== '' && last.target !== named && !last.target.endsWith(`/${named}`)) {
      return { text: `Assertion Guardian: the blocked change is to ${last.target}, not ${named}. Nothing allowed.` }
    }
    await allow($, last)
    return { text: `Assertion Guardian: the blocked change to ${last.target} may run once, exactly as proposed.` }
  })

  on('tool.call', async ($, e, next) => {
    const call = e as { tool: string; [k: string]: unknown }
    const found = await check($, call)
    if (found === null || found.signals.length === 0) return next(e)

    const fp = await fingerprint(call)
    let spent = false
    await update($, allowed, list => {
      if (!list.includes(fp)) return list
      spent = true
      return list.filter(one => one !== fp)
    })
    if (spent) return next(e)

    await update($, blocked, (): Blocked => ({ target: found.target, signals: found.signals, fp }))
    return { deny: refusal(found.target, found.signals) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const last = await read($, blocked)
    if (last === null || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const name = last.target.split('/').pop() ?? last.target
    const first = last.signals[0] ?? ''
    const room = Math.max(20, (e.props.bodyColumns ?? 80) - name.length - 40)
    const reason = first.length > room ? `${first.slice(0, room - 1)}…` : first
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="red">⛨ blocked </Text>
          <Text bold>{name}</Text>
          <Text dimColor>: {reason} </Text>
          <Button key="allow" label="allow once" onPress={() => allow($, last)} />
          <Button key="dismiss" label="dismiss" onPress={() => update($, blocked, () => null)} />
        </Box>
        {below}
      </Box>
    )
  })
}

async function allow($: EngineInterface, which: Blocked) {
  await update($, allowed, list => (list.includes(which.fp) ? list : [...list, which.fp]))
  await update($, blocked, cur => (cur !== null && cur.fp === which.fp ? null : cur))
}
