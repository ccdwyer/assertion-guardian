import { describe, expect, test } from 'claude-code/testing'

import { bashSignals, isTestFile, weakening } from '../hooks/analyze'

const SPEC = `describe('sum', () => {
  it('adds', () => {
    expect(sum(1, 2)).toBe(3)
    expect(sum(-1, 1)).toEqual(0)
  })
  it('handles zero', () => {
    expect(sum(0, 0)).toBe(0)
  })
})
`
const P = '/a/sum.test.ts'
const sig = (after: string, before = SPEC, path = P) => weakening(before, after, path).join(' | ')

describe('which files', () => {
  test('recognises test files and leaves fixtures and docs alone', async () => {
    for (const p of ['/a/sum.test.ts', '/a/__tests__/x.js', '/a/tests/test_api.py', '/a/app/tests.py', '/a/x_test.go', '/a/FooTests.swift', '/a/__snapshots__/x.snap', '/a/test/api.js']) {
      expect(isTestFile(p)).toBe(true)
    }
    for (const p of ['/a/src/sum.ts', '/a/testing-utils.ts', '/a/contest.py', '/a/docs/spec/api.md', '/a/spec/openapi.yaml', '/a/test/fixtures/sample.js']) {
      expect(isTestFile(p)).toBe(false)
    }
  })
})

describe('weakening', () => {
  test('removed, loosened, skipped, focused, commented, swallowed, deleted', async () => {
    expect(sig(SPEC.replace("    expect(sum(-1, 1)).toEqual(0)\n", ''))).toMatch(/assertions removed/)
    expect(sig(SPEC.replace('.toBe(3)', '.toBeTruthy()'))).toMatch(/exact matchers replaced/)
    expect(sig(SPEC.replace("it('handles zero'", "it.skip('handles zero'"))).toMatch(/skipped/)
    expect(sig(SPEC.replace("it('adds'", "it.only('adds'"))).toMatch(/focus added/)
    expect(sig(SPEC.replace("it('adds'", "it.only('adds'"))).not.toMatch(/cases deleted/)
    expect(sig(SPEC.replace('    expect(sum(1, 2))', '    // expect(sum(1, 2))'))).toMatch(/commented out/)
    expect(sig(SPEC.replace("  it('handles zero', () => {\n    expect(sum(0, 0)).toBe(0)\n  })\n", ''))).toMatch(/test cases deleted/)
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    try { expect(sum(0, 0)).toBe(0) } catch {}'))).toMatch(/swallowed/)
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    try { expect(sum(0, 0)).toBe(0) } catch (e: unknown) { console.log(e) }'))).toMatch(/swallowed/)
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    if (false) { expect(sum(0, 0)).toBe(0) }'))).toMatch(/dead branch/)
  })

  test('the edits the reviewers found slipping through', async () => {
    expect(sig(SPEC.replace('.toEqual(0)', '.toEqual(expect.any(Number))'))).toMatch(/vague matchers|expected values/)
    expect(sig(SPEC.replace('.toBe(3)', '.toBe(4)'))).toMatch(/expected values changed.*`3`/)
    expect(sig(SPEC.replace('expect(sum(1, 2)).toBe(3)', 'expect(true).toBe(true)'))).toMatch(/constant assertions/)
    const spy = "it('calls', () => {\n  expect(fn).toHaveBeenCalledWith(1)\n})\n"
    expect(sig(spy.replace('toHaveBeenCalledWith(1)', 'toHaveBeenCalled()'), spy)).toMatch(/expected values/)
    const inline = 'it(\'renders\', () => {\n  expect(out).toMatchInlineSnapshot(`"old"`)\n})\n'
    expect(sig(inline.replace('old', 'new'), inline)).toMatch(/expected values/)
    const node = 'test("a", () => {\n  assert.strictEqual(sum(1, 2), 3)\n  assert.deepEqual(obj, { a: 1 })\n})\n'
    expect(sig('test("a", () => {\n  assert.ok(true)\n})\n', node)).toMatch(/assertions removed/)
  })

  test('strings, docstrings and comments are not code', async () => {
    expect(sig(SPEC.replace("  it('adds'", "  // expect(result) once the API returns it\n  it('adds'"))).toBe('')
    expect(sig(SPEC.replace("  it('adds'", "  /** @example expect(sum(1, 2)).toBe(3) */\n  it('adds'"))).toBe('')
    const added = SPEC.replace('})\n', "  it('reads src', () => {\n    expect(src).toContain(\"it.only('x')\")\n    expect(src).toContain('catch (e) {}')\n  })\n})\n")
    expect(sig(added)).toBe('')
    expect(sig(SPEC.replace('    expect(sum(-1, 1)).toEqual(0)', '    const doc = "expect(sum(-1, 1)).toEqual(0)"'))).toMatch(/assertions removed/)
    const py = 'def test_a():\n    """assert something about a"""\n    assert f() == 1\n'
    expect(sig('def test_a():\n    assert f() == 1\n', py, '/t/test_a.py')).toBe('')
    expect(sig(SPEC.replace('expect(x)', 'model.fit(x, y)') + 'model.fit(a, b)\n')).toBe('')
    expect(sig('it("d", () => {\n  XCTAssertEqual(try? decode(), 1)\n})\n', 'it("d", () => {\n  XCTAssertEqual(decode(), 1)\n})\n')).not.toMatch(/swallowed/)
  })

  test('lets legitimate refactors through', async () => {
    const renamed = SPEC.replace("it('adds'", "it('adds two numbers'")
    const added = SPEC.replace('})\n', "  it('negatives', () => {\n    expect(sum(-1, -1)).toBe(-2)\n  })\n})\n")
    const stronger = SPEC.replace('.toEqual(0)', '.toStrictEqual(0)')
    const quotes = SPEC.replace(/'/g, '"')
    const moved = `describe('sum', () => {
  it('handles zero', () => {
    expect(sum(0, 0)).toBe(0)
  })
  it('adds', () => {
    expect(sum(-1, 1)).toEqual(0)
    expect(sum(1, 2)).toBe(3)
  })
})
`
    for (const after of [renamed, added, stronger, moved, quotes]) expect(sig(after)).toBe('')
    expect(sig('it("n", () => {\n  expect(x).toBeNull()\n})\n', 'it("n", () => {\n  expect(x).toBe(null)\n})\n')).toBe('')
    expect(sig(SPEC, '')).toBe('')
  })

  test('python', async () => {
    const py = 'def test_a():\n    assert f() == 1\n'
    expect(sig('@pytest.mark.skip\n' + py, py, '/t/test_a.py')).toMatch(/skipped/)
    expect(sig('def test_a():\n    try:\n        assert f() == 1\n    except AssertionError:\n        pass\n', py, '/t/test_a.py')).toMatch(/swallowed/)
    expect(sig('# def test_a():\n#     assert f() == 1\n', py, '/t/test_a.py')).toMatch(/deleted/)
    expect(sig('def test_a():\n    assert f() == 2\n', py, '/t/test_a.py')).toMatch(/expected values/)
  })
})

describe('round 2 findings', () => {
  test('tautologies and flipped polarity', async () => {
    expect(sig(SPEC.replace('expect(sum(1, 2)).toBe(3)', 'expect(3).toBe(3)'))).toMatch(/constant assertions/)
    expect(sig(SPEC.replace('expect(sum(1, 2)).toBe(3)', 'expect([3][0]).toBe(3)'))).toMatch(/constant assertions/)
    expect(sig(SPEC.replace('expect(sum(1, 2)).toBe(3)', 'expect(sum(1, 2)).not.toBe(3)'))).toMatch(/polarity/)
    const node = 'test("a", () => {\n  assert.strictEqual(sum(1, 2), 3)\n})\n'
    expect(sig(node.replace('strictEqual', 'notStrictEqual'), node)).toMatch(/polarity/)
    const added = SPEC.replace('})\n', "  it('never negative', () => {\n    expect(sum(1, 1)).not.toBe(-2)\n  })\n})\n")
    expect(sig(added)).toBe('')
  })

  test('literal bodies compare exactly, code whitespace does not matter', async () => {
    const s1 = 'it("w", () => {\n  expect(out).toBe("a  b")\n})\n'
    expect(sig(s1.replace('a  b', 'a b'), s1)).toMatch(/expected values/)
    const o = 'it("o", () => {\n  expect(x).toEqual({a:1})\n})\n'
    expect(sig(o.replace('{a:1}', '{ a: 1 }'), o)).toBe('')
  })

  test('renames of the subject pass, expected operands are what count', async () => {
    const node = 'test("a", () => {\n  assert.strictEqual(sum(1, 2), 3)\n})\n'
    expect(sig(node.replace('sum(1, 2)', 'result'), node)).toBe('')
    const py = 'def test_a():\n    assert actual == 3\n'
    expect(sig(py.replace('actual', 'result'), py, '/t/test_a.py')).toBe('')
    expect(sig('def test_a():\n    assert (\n        f() == 2\n    )\n', 'def test_a():\n    assert (\n        f() == 1\n    )\n', '/t/test_a.py')).toMatch(/expected values/)
    expect(sig('it("x", () => { XCTAssertEqual(g(), 1) })\n', 'it("x", () => { XCTAssertEqual(f(), 1) })\n')).toBe('')
  })

  test('assertj, chai, rspec and template interpolations', async () => {
    const j = '@Test void a() {\n  assertThat(f()).isEqualTo(1);\n}\n'
    expect(sig(j.replace('isEqualTo(1)', 'isEqualTo(2)'), j, '/a/FooTest.java')).toMatch(/expected values/)
    const chai = 'it("c", () => {\n  expect(f()).to.equal(1)\n})\n'
    expect(sig(chai.replace('equal(1)', 'equal(2)'), chai)).toMatch(/expected values/)
    const rb = 'it "r" do\n  expect(f).to eq(1)\nend\n'
    expect(sig(rb.replace('eq(1)', 'eq(2)'), rb, '/a/x_spec.rb')).toMatch(/expected values/)
    const tpl = 'it("t", () => {\n  const m = `${expect(actual).toBe(3)}`\n})\n'
    expect(sig(tpl.replace('toBe(3)', 'toBe(4)'), tpl)).toMatch(/expected values/)
  })

  test('table rows, more skips, swallowing that is not cleanup', async () => {
    const go = 'func TestAdd(t *testing.T) {\n  tests := []struct{ a, b, want int }{{1, 2, 3}, {0, 0, 0}}\n  for _, c := range tests { if Add(c.a, c.b) != c.want { t.Fatalf("bad") } }\n}\n'
    expect(sig(go.replace(', {0, 0, 0}', ''), go, '/a/add_test.go')).toMatch(/data rows/)
    const rb = 'it "r" do\n  expect(f).to eq(1)\nend\n'
    expect(sig(rb.replace('it "r" do', "it \"r\" do\n  skip 'later'"), rb, '/a/x_spec.rb')).toMatch(/skipped/)
    const cleanup = SPEC.replace("    expect(sum(0, 0)).toBe(0)", "    try { fs.rmSync(p) } catch {}\n    expect(sum(0, 0)).toBe(0)")
    expect(sig(cleanup)).toBe('')
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    try { expect(sum(0, 0)).toBe(0) } catch (e) { return }'))).toMatch(/swallowed/)
    expect(sig(SPEC.replace("  it('adds'", "  if (false) { console.log('x') }\n  it('adds'"))).toBe('')
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    if (!ready) return\n    expect(sum(0, 0)).toBe(0)'))).toBe('')
    expect(sig(SPEC.replace('expect(sum(1, 2)).toBe(3)', 'expect.soft(sum(1, 2)).toBe(3)'))).toBe('')
    expect(sig(SPEC + 'const r = fit(a, b)\n')).toBe('')
  })
})

describe('round 3 findings', () => {
  test('a looser or flipped matcher on the same value', async () => {
    expect(sig(SPEC.replace('.toBe(3)', '.toBeGreaterThanOrEqual(3)'))).toMatch(/expected values/)
    expect(sig(SPEC.replace('.toBe(3)', '.toBeCloseTo(3)'))).toMatch(/expected values/)
    const o = 'it("o", () => {\n  expect(x).toStrictEqual({a:1})\n})\n'
    expect(sig(o.replace('toStrictEqual', 'toEqual'), o)).toMatch(/looser matcher/)
    expect(sig(o, o.replace('toStrictEqual', 'toEqual'))).toBe('')
    const padded = SPEC.replace('expect(sum(1, 2)).toBe(3)', 'expect(sum(1, 2)).not.toBe(3)').replace('})\n', "  it('pad', () => {\n    expect(sum(2, 2)).toBe(4)\n  })\n})\n")
    expect(sig(padded)).toMatch(/polarity/)
  })

  test('python comparisons keep their operator', async () => {
    const py = (body: string) => `def test_a():\n    assert ${body}\n`
    const at = '/t/test_a.py'
    expect(sig(py('f() != 3'), py('f() == 3'), at)).toMatch(/polarity|expected values/)
    expect(sig(py('x is not None'), py('x is None'), at)).toMatch(/polarity|expected values/)
    expect(sig(py('n < 3'), py('n > 3'), at)).toMatch(/expected values/)
    expect(sig(py('x == 9 and y == 2'), py('x == 1 and y == 2'), at)).toMatch(/expected values/)
    expect(sig(py('3 == 3'), py('f() == 3'), at)).toMatch(/constant/)
  })

  test('constant direct assertions, but a literal subject against real code is fine', async () => {
    const node = 'test("a", () => {\n  assert.strictEqual(sum(1, 2), 3)\n})\n'
    expect(sig(node.replace('sum(1, 2)', '3'), node)).toMatch(/constant/)
    const xc = 'func testA() {\n  XCTAssertEqual(f(), 3)\n}\n'
    expect(sig(xc.replace('f()', '3'), xc, '/a/FooTests.swift')).toMatch(/constant/)
    expect(sig(SPEC.replace('})\n', "  it('flip', () => {\n    expect(0).toBe(sum(0, 0))\n  })\n})\n"))).toBe('')
    expect(sig(node.replace(', 3)', ', 3, "oops")'), node.replace(', 3)', ', 3, "bad")'))).toBe('')
  })

  test('option objects are not data rows, table rows are', async () => {
    const w = 'it("w", async () => {\n  await waitFor(() => ready(), { timeout: 1000, interval: 50 })\n  expect(ready()).toBe(true)\n})\n'
    expect(sig(w.replace('1000', '2000'), w)).toBe('')
    const each = 'test.each([[1, 1, 2], [2, 2, 4]])("adds", (a, b, c) => {\n  expect(sum(a, b)).toBe(c)\n})\n'
    expect(sig(each.replace(', [2, 2, 4]', ''), each)).toMatch(/data rows/)
  })

  test('assertions defused by pytest.raises or expect().toThrow, and regex literals', async () => {
    const py = 'def test_a():\n    assert f() == 1\n'
    expect(sig('def test_a():\n    with pytest.raises(AssertionError):\n        assert f() == 1\n', py, '/t/test_a.py')).toMatch(/swallowed/)
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    expect(() => expect(sum(0, 0)).toBe(0)).toThrow()'))).toMatch(/swallowed/)
    expect(sig('def test_a():\n    try:\n        assert f() == 1\n    except AssertionError: pass\n', py, '/t/test_a.py')).toMatch(/swallowed/)
    const rx = 'it("r", () => {\n  expect(u).toMatch(/https:\\/\\/ex/); expect(sum(1, 2)).toBe(3)\n})\n'
    expect(sig(rx.replace('toBe(3)', 'toBe(4)'), rx)).toMatch(/expected values/)
  })
})

describe('round 4 findings', () => {
  const one = (line: string) => `it("x", () => {\n  ${line}\n})\n`
  test('ordering and closeness keep their relation and precision', async () => {
    expect(sig(one('expect(n).toBeLessThan(3)'), one('expect(n).toBeGreaterThan(3)'))).toMatch(/expected values/)
    expect(sig(one('expect(n).toBeGreaterThanOrEqual(3)'), one('expect(n).toBeGreaterThan(3)'))).toMatch(/expected values/)
    expect(sig(one('expect(n).toBeCloseTo(3, 0)'), one('expect(n).toBeCloseTo(3)'))).toMatch(/expected values/)
    expect(sig(one('expect(n).toBeCloseTo(3, 2)'), one('expect(n).toBeCloseTo(3)'))).toBe('')
    expect(sig('def test_a():\n    assert 0 < n < 100\n', 'def test_a():\n    assert 0 < n < 10\n', '/t/test_a.py')).toMatch(/expected values/)
  })

  test('negated matchers keep their strictness', async () => {
    expect(sig(one('expect(a).not.toStrictEqual({a: 1})'), one('expect(a).not.toEqual({a: 1})'))).toMatch(/expected values/)
    const php = '@Test void a() {\n  $this->assertSame(3, f());\n}\n'
    expect(sig(php.replace('assertSame', 'assertEquals'), php, '/a/FooTest.php')).toMatch(/expected values/)
  })

  test('blocks are not tables; a catch that only asserts still swallows', async () => {
    const opts = one('const opts = { timeout: 1000, interval: 50 }\n  expect(ready()).toBe(true)')
    expect(sig(opts.replace('1000', '2000'), opts)).toBe('')
    const go = 'func TestAdd(t *testing.T) {\n  tests := []struct{ a, b, want int }{{1, 2, 3}, {0, 0, 0}}\n  _ = tests\n}\n'
    expect(sig(go.replace(', {0, 0, 0}', ''), go, '/a/add_test.go')).toMatch(/data rows/)
    expect(sig(SPEC.replace('    expect(sum(0, 0)).toBe(0)', '    try { expect(sum(0, 0)).toBe(0) } catch (e) { expect(e).toBeDefined() }'))).toMatch(/swallowed/)
    const py = 'def test_a():\n    assert f() == 1\n'
    expect(sig('def test_a():\n    with pytest.raises(Exception):\n        assert f() == 1\n', py, '/t/test_a.py')).toMatch(/swallowed/)
    expect(sig('import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.skipTest("later")\n        assert f() == 1\n', 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        assert f() == 1\n', '/t/test_a.py')).toMatch(/skipped/)
  })

  test('regex literals after return and arrows; more shell forms', async () => {
    const rx = one('const re = () => /https:\\/\\/x/; expect(sum(1, 2)).toBe(3)')
    expect(sig(rx.replace('toBe(3)', 'toBe(4)'), rx)).toMatch(/expected values/)
    expect(bashSignals('node node_modules/jest/bin/jest.js -u').join()).toMatch(/snapshot/)
    expect(bashSignals('patch src/sum.test.ts < fix.diff').join()).toMatch(/through the shell/)
  })
})

describe('bash', () => {
  test('snapshot updates, and only real ones', async () => {
    for (const c of ['npx jest -u', "npx jest '-u'", 'yarn test --updateSnapshot', 'npm test -- -u', 'npx playwright test --update-snapshots', 'INSTA_UPDATE=1 cargo test', 'cargo insta accept', 'pytest --snapshot-update', 'env npx jest -u', 'npx --yes jest -u', 'pnpm --filter app test -u', 'pnpm exec vitest -u', 'npm --prefix packages/app test -- -u', 'python -m pytest --snapshot-update', 'npx jest --updateSnapshot=true', 'npx loki update', 'backstop approve', 'npx chromatic --auto-accept-changes', 'yarn workspace app test -u', 'npm exec -- jest -u', 'pnpm --filter app exec vitest -u']) {
      expect(bashSignals(c).join()).toMatch(/snapshot/)
    }
    for (const c of ['npm test', 'git add -u && npm test', 'npm test && git add -u', 'go get -u golang.org/x/sys', 'npx npm-check-updates -u', 'yarn upgrade -u', 'npm install --update-notifier false', 'npx jest --ci=false']) {
      expect(bashSignals(c)).toEqual([])
    }
  })

  test('shell writes to test files', async () => {
    for (const c of ['rm src/sum.test.ts', "sed -i '' 's/toBe(3)/toBeTruthy()/' src/sum.test.ts", "echo 'x' > tests/test_a.py", 'git rm src/sum.test.ts', 'python -c "open(\'src/sum.test.ts\',\'w\').write(\'\')"', 'mv src/sum.test.ts /tmp/', 'rm -rf tests', 'rm -rf src/__snapshots__', 'git rm -r __tests__', 'git checkout HEAD~1 -- src/sum.test.ts', 'git restore --source=HEAD~1 src/sum.test.ts', 'bash -c "rm src/sum.test.ts"', "find tests -name '*.py' -delete", 'rm -rf tests/*', 'rm -rf tests/unit', 'rm -rf src/__tests__/components', 'git checkout HEAD~1 src/sum.test.ts', 'git checkout --theirs src/sum.test.ts', 'git restore --source HEAD~1 -- src/sum.test.ts', 'git -C /repo rm src/sum.test.ts', 'sudo rm -rf tests']) {
      expect(bashSignals(c).join()).toMatch(/through the shell/)
    }
    for (const c of ['cat src/sum.test.ts', "sed -n '1,5p' src/sum.test.ts", 'npx jest src/sum.test.ts > /tmp/out.txt 2>&1', 'cp src/sum.test.ts /tmp/backup.ts', 'git checkout -- src/sum.test.ts', "find src -name '*.test.ts' -exec cat {} ;", 'ls tests', "find tests -name '*.pyc' -delete", 'cp -r tests /tmp/tests']) {
      expect(bashSignals(c)).toEqual([])
    }
  })
})

const run = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
// git rev-parse answers the repo root, git show answers `shown`.
const git = (shown: ReturnType<typeof run>) => (_$: unknown, e: { argv: readonly string[] }) => (e.argv.includes('rev-parse') ? run('/repo\n') : shown)

describe('hooks', () => {
  test('a loosening Edit is refused, then the same call is allowed once by the command', async ($, on) => {
    let writes = 0
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: SPEC }))
    on('tool.call', () => {
      writes += 1
      return { result: { staged: false } }
    })
    const edit = { tool: 'Edit' as const, file_path: '/repo/sum.test.ts', old_string: '.toBe(3)', new_string: '.toBeTruthy()' }
    expect((await $.tool.call(edit)).deny).toMatch(/exact matchers replaced/)
    const run = { command: 'allow-test-change', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
    await $.command.run(run)
    // A different weakening of the same file does not ride on that allowance.
    const other = { ...edit, old_string: '.toEqual(0)', new_string: '.toBeDefined()' }
    expect((await $.tool.call(other)).deny).toMatch(/Assertion Guardian/)
    expect(writes).toBe(0)
    await $.command.run(run)
    expect((await $.tool.call(other)).deny).toBeUndefined()
    expect((await $.tool.call(other)).deny).toMatch(/Assertion Guardian/)
    expect(writes).toBe(1)
  })

  test('a deleted test file is compared with what git committed', async ($, on) => {
    on('fs.exists', (_$, e) => ({ value: e.path === '/repo' }))
    on('process.run', git(run(SPEC)))
    on('tool.call', () => ({ result: 'ok' }))
    const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/sum.test.ts', content: "it('x', () => {\n  expect(true).toBe(true)\n})\n" })
    expect(ran.deny).toMatch(/test cases deleted/)
  })

  test('source files, harmless test edits and new test files run untouched', async ($, on) => {
    let writes = 0
    on('fs.exists', (_$, e) => ({ value: !e.path.includes('new') }))
    on('fs.read', () => ({ value: SPEC }))
    on('process.run', git(run('', 128, "fatal: path 'new.test.ts' does not exist in 'HEAD'")))
    on('tool.call', () => {
      writes += 1
      return { result: { staged: false } }
    })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/sum.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/sum.test.ts', old_string: "'adds'", new_string: "'adds numbers'" })
    await $.tool.call({ tool: 'Write', file_path: '/repo/new.test.ts', content: "it('x', () => {\n  expect(sum(1, 1)).toBe(2)\n})\n" })
    expect(writes).toBe(3)
  })

  test('the band shows the block and its allow button clears it', async ($, on) => {
    on('ui.render', ($$, e) => {
      const { Box, Text } = $$.ui.resolve(e)
      return (
        <Box>
          <Text>band from another mod</Text>
        </Box>
      )
    })
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: SPEC }))
    on('tool.call', () => ({ result: { staged: false } }))
    await $.tool.call({ tool: 'Bash', command: 'npx jest -u' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'assertion-guardian', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } } as never)
      expect(await ui.find({ type: 'Text', text: /blocked/ })).toBeDefined()
      // The band composes with what lower plugins draw instead of replacing it.
      expect(await ui.find({ type: 'Text', text: /band from another mod/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'assertion-guardian', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } } as never)
    await ui.press({ key: 'allow' })
    expect((await $.tool.call({ tool: 'Bash', command: 'npx jest -u' })).deny).toBeUndefined()
    await ui.unmount()
  })
})
