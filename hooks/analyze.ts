// Pure analysis: is the new version of a test file weaker than the old one?
//
// A light scanner first separates code from comments and string literals, so
// an assertion inside a docstring, a comment or a fixture string is never
// counted as code (template interpolations are code, and are scanned as such).
// The counts, the expected values and the literal data rows then decide.

const TEST_NAME = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)tests\.py$/,
  /_test\.(py|go|exs?|rb|dart)$/,
  /_spec\.rb$/,
  /Tests?\.(swift|kt|java|cs|scala|php)$/,
  /Spec\.(kt|scala|groovy)$/,
]
const TEST_DIR = /(^|\/)(__tests__|tests?|spec|androidTest|testDebug)\//
const NOT_TEST_DIR = /(^|\/)(fixtures?|__fixtures__|support|helpers?|factories|__mocks__|mocks|data|testdata)\//
const CODE_FILE = /\.([cm]?[jt]sx?|py|rb|exs?|go|swift|kt|java|cs|scala|groovy|dart|rs|php|ipynb)$/
const SNAPSHOT_PATH = [/\.snap$/, /(^|\/)__snapshots__\//, /(^|\/)__image_snapshots__\//]
const HASH_COMMENT = /\.(py|rb|exs?|sh|r|pl)$/i
// A directory that holds tests or snapshots, as a shell operand (`rm -rf tests`).
const TEST_DIR_OPERAND = /(^|\/)(__tests__|tests?|spec|__snapshots__|__image_snapshots__)(\/|$)/

export const isSnapshot = (path: string) => SNAPSHOT_PATH.some(r => r.test(path))
export function isTestFile(path: string): boolean {
  if (isSnapshot(path)) return true
  if (TEST_NAME.some(r => r.test(path))) return true
  return TEST_DIR.test(path) && !NOT_TEST_DIR.test(path) && CODE_FILE.test(path)
}

// ---------------------------------------------------------------------------
// Scanner

export type Scanned = {
  // The source with every string literal replaced by "§n" and every comment
  // removed; line breaks are kept, so line i of `code` is line i of the source.
  code: string
  literals: string[]
  // Comment text, one entry per line, markers stripped.
  comments: string[]
}

// The index just past the `}` closing a `${` that opens at `from`.
function interpolationEnd(text: string, from: number): number {
  let depth = 1
  let i = from
  while (i < text.length && depth > 0) {
    const c = text[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === '"' || c === "'" || c === '`') {
      const q = c
      i += 1
      while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1
    }
    i += 1
  }
  return i
}

export function scan(text: string, hashComments: boolean): Scanned {
  const literals: string[] = []
  const comments: string[] = []
  let code = ''
  let i = 0
  const n = text.length
  const keepLines = (s: string) => '\n'.repeat((s.match(/\n/g) ?? []).length)
  const literal = (body: string) => `"§${literals.push(body) - 1}"`
  while (i < n) {
    const c = text[i]!
    const two = text.slice(i, i + 2)
    const three = text.slice(i, i + 3)
    if ((hashComments && c === '#') || (!hashComments && two === '//')) {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? n : end
      comments.push(text.slice(i, stop).replace(/^(#+|\/\/+)\s?/, ''))
      i = stop
      continue
    }
    if (!hashComments && two === '/*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      const body = text.slice(i + 2, end < 0 ? n : end)
      for (const line of body.split('\n')) comments.push(line.replace(/^\s*\*\s?/, ''))
      code += keepLines(body)
      i = stop
      continue
    }
    if (!hashComments && c === '/' && two !== '//' && two !== '/*' && (/[(,=:[!&|?{};>]$|^$/.test(code.trimEnd().slice(-1)) || /\b(return|throw|case|typeof|void|delete|await|yield)$/.test(code.trimEnd()))) {
      // A regex literal (after an operator or opening bracket): keep it whole
      // so a // inside it is not read as a comment.
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1
        else if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        j += 1
      }
      if (text[j] === '/') {
        code += literal(text.slice(i, j + 1))
        i = j + 1
        continue
      }
    }
    if (three === '"""' || three === "'''") {
      const end = text.indexOf(three, i + 3)
      const stop = end < 0 ? n : end + 3
      const body = text.slice(i + 3, end < 0 ? n : end)
      code += literal(body) + keepLines(body)
      i = stop
      continue
    }
    if (c === '`' && !hashComments) {
      // A template literal: its text is a literal, each ${...} is code.
      let j = i + 1
      let raw = ''
      const parts: string[] = []
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') {
          raw += text.slice(j, j + 2)
          j += 2
        } else if (text.slice(j, j + 2) === '${') {
          const end = interpolationEnd(text, j + 2)
          const inner = scan(text.slice(j + 2, end - 1), hashComments)
          const offset = literals.length
          literals.push(...inner.literals)
          comments.push(...inner.comments)
          parts.push(inner.code.replace(/"§(\d+)"/g, (_, k: string) => `"§${Number(k) + offset}"`))
          raw += '${}'
          j = end
        } else {
          raw += text[j]
          j += 1
        }
      }
      code += literal(raw) + (parts.length > 0 ? `(${parts.join(',')})` : '') + keepLines(raw)
      i = j + 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j += 1
        else if (text[j] === '\n' && c !== '`') break
        j += 1
      }
      const body = text.slice(i + 1, Math.min(j, n))
      code += literal(body) + keepLines(body)
      i = text[j] === c ? j + 1 : j
      continue
    }
    code += c
    i += 1
  }
  return { code, literals, comments }
}

// ---------------------------------------------------------------------------
// What gets counted (always over `code`, where strings are "§n")

const ASSERTION =
  /\bexpect(\.(soft|poll))?\s*\(|#expect\s*\(|#require\s*\(|\bXCTAssert\w*|\bXCTFail\b|\bassert(\.\w+)+\s*\(|\bassert\w*\s*[(!]|\bassert\s+[^\s=]|\bassertThat\s*\(|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\.should\b|\bshould\.\w+|\bself\.assert\w+\s*\(|\bpytest\.raises\b|\brefute\w*\b|\$this->assert\w+\s*\(/g
const SKIP =
  /\b(xit|xdescribe|xtest|xcontext|xspecify)\s*\(|\b(it|test|describe|context|suite|specify)\.(skip|todo|fixme|fail)\b|\b(it|test|describe)\.skipIf\b|\bthis\.skip\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.(skip|xfail)\s*\(|@unittest\.(skip\w*|expectedFailure)|@(Ignore|Disabled\w*)\b|\bt\.Skip(f|Now)?\s*\(|\bXCTSkip\w*\b|\bskip\s*\(?\s*"§|markTestSkipped\s*\(|markTestIncomplete\s*\(|@tag\s*:skip\b|@moduletag\s*:skip\b|\bself\.skipTest\s*\(|#\[ignore\]/g
const FOCUS = /\b(fdescribe|fcontext)\s*\(|\b(fit|ftest)\s*\(\s*"§|\b(it|test|describe|context|suite)\.only\b/g
const CASE =
  /\b(it|test|specify|scenario)(\.(only|skip|todo|concurrent|fails|fixme|each\s*\([^)]*\)))?\s*\(\s*"§|@Test\b(\s*\([^)]*\))?\s*func\s+\w+\s*\(|\bfunc\s+test\w*\s*\(|\bdef\s+test_\w*|\bfunc\s+Test\w*|@Test\b|\[(Fact|Theory|Test|TestMethod)\]|\b(it|test|specify)\s+"§/g
// Calls whose arguments are expected values.
const EXPECTED_CALL =
  /\.(toBe|toEqual|toStrictEqual|toHaveBeenCalledWith|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith|toHaveBeenCalledTimes|toThrow|toThrowError|toMatch|toContain|toContainEqual|toHaveLength|toHaveProperty|toMatchSnapshot|toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toBeCloseTo|toHaveText|toHaveValue|toHaveURL|isEqualTo|isNotEqualTo|isSameAs|hasSize|containsExactly|isCloseTo)\s*\(|\.(to|be|been|is|that|and|have|deep|not)\.(\w+\.)*(equal|eql|equals|include|includes|contain|property|lengthOf|match|members|above|below|closeTo|throw)\s*\(|\.(to|not_to|to_not)\s+(eq|eql|equal|be|match|include|contain_exactly|match_array|raise_error|have_attributes)\s*\(|\bassert\.(strictEqual|deepStrictEqual|deepEqual|equal|notEqual|notStrictEqual|notDeepEqual|throws|rejects|match|doesNotMatch)\s*\(|\b(self\.)?assert(Equal|Equals|NotEqual|Same|Is|IsNot|In|NotIn|Raises|Count\w*|Dict\w*|List\w*|Regex|AlmostEqual|Greater|Less)\w*\s*\(|\$this->assert(Equals|Same|Count|Contains)\w*\s*\(|\bXCTAssert(Equal|NotEqual|Identical|Throws\w*|GreaterThan|LessThan)\w*\s*\(|\bassert_eq!\s*\(|\bassert_ne!\s*\(|#expect\s*\(/g
// Matchers that pin nothing down beyond "something is there".
const VAGUE_ONLY = /\.(toBeTruthy|toBeDefined|toBeFalsy|toMatchObject)\s*\(\s*\)?|\bexpect\.(anything|any)\s*\(|\bXCTAssertNotNil\b|\bassertIsNotNone\b|\bassert\.ok\s*\(/g
// An exact matcher (an expected-value call, or one whose name is the value).
const EXACT = new RegExp(`${EXPECTED_CALL.source}|\\.(toBeNull|toBeUndefined|toBeNaN|toHaveBeenCalled)\\s*\\(|\\bXCTAssertNil\\b|\\bassertIsNone\\b`, 'g')
const NEGATION = /\.not\.|\.not_to\b|\.to_not\b|\bassert\.not\w+\s*\(|\b(self\.)?assertNot\w*\s*\(|\bXCTAssertNot\w+|\bassert_ne!|\bassertThat\([^)]*\)\.isNot\w+|\$this->assertNot\w+/g
const TRIVIAL =
  /\bassert\s+(True|1)\b|\bassert(\.ok)?\s*\(\s*(true|1)\s*\)|\b(self\.)?assertTrue\s*\(\s*(true|True|1)\s*\)|\bXCTAssertTrue\s*\(\s*true\s*\)|#expect\s*\(\s*true\s*\)|\bassert!\s*\(\s*true\s*\)/g
const DISABLED = /\bif\s*\(\s*(false|0)\s*\)\s*\{[^}]*?\b(expect|assert)|\bif\s+(False|0)\s*:\s*\n[ \t]+(self\.)?assert|^[ \t]*return\s*;?[ \t]*\n\s*(expect|assert)/gm

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length

// The text from `start` (just inside an opening paren) to its matching close.
function argsFrom(code: string, start: number): string {
  let depth = 1
  let j = start
  while (j < code.length && depth > 0) {
    const ch = code[j]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    j += 1
  }
  return code.slice(start, j - 1)
}

// Splits on top-level commas.
function topLevel(args: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of args) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

// A value made of literals only: strings, numbers, booleans, null, and
// objects or arrays of them (object keys allowed). No variable, no call.
function isLiteral(expr: string): boolean {
  const e = expr.replace(/\s+/g, '')
  if (e === '') return false
  const rest = e
    .replace(/"§\d+"/g, '0')
    .replace(/[\w$]+:/g, '')
    .replace(/\b(true|false|null|undefined|None|nil|True|False|NaN|Infinity)\b/g, '0')
    .replace(/-?\d[\d_.eExXa-fA-F]*/g, '0')
  return !/[A-Za-z_$]/.test(rest)
}

// One expected value an assertion pins down: the value (literals restored),
// whether the assertion is negated, and how strict the matcher is.
export type Expected = { value: string; negated: boolean; rank: number }

type Values = { expected: Expected[]; rows: string[]; constants: number }

// Strict equality 4, equality 3, membership/shape 2, ordering or closeness 1.
function rank(matcher: string): number {
  if (/^(toBe|toStrictEqual|strictEqual|notStrictEqual|deepStrictEqual|assert_eq!|assert_ne!|isSameAs|XCTAssertIdentical|assertSame|toBeNull|toBeUndefined|toBeNaN)$/.test(matcher)) return 4
  if (/^(toEqual|deepEqual|notDeepEqual|equal|notEqual|eq|eql|equals|isEqualTo|isNotEqualTo|assertEqual\w*|assertNotEqual\w*|assertEquals|XCTAssertEqual\w*|XCTAssertNotEqual\w*|toHaveBeenCalledWith|toHaveBeenNthCalledWith|toHaveBeenLastCalledWith|toHaveBeenCalledTimes|toMatchSnapshot|toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot|toHaveLength|hasSize|#expect)$/.test(matcher)) return 3
  if (/(Greater|Less|Above|Below|above|below|CloseTo|closeTo|AlmostEqual)/.test(matcher)) return 1
  return 2
}

// Ordering and closeness matchers keep their relation with the value, so
// > 3 → >= 3 or > 3 → < 3 is a change. Longest names first.
const RELATION: [RegExp, string][] = [
  [/(GreaterThanOrEqual|GreaterOrEqual|GreaterEqual|AtLeast|isGreaterThanOrEqualTo)$/, '>='],
  [/(LessThanOrEqual|LessOrEqual|LessEqual|AtMost|isLessThanOrEqualTo)$/, '<='],
  [/(GreaterThan|Greater|isGreaterThan|above)$/, '>'],
  [/(LessThan|Less|isLessThan|below)$/, '<'],
  [/(CloseTo|closeTo|isCloseTo|AlmostEqual)$/, '~'],
]

const NEGATED_MATCHER = /^(notStrictEqual|notEqual|notDeepEqual|assertNot\w*|XCTAssertNot\w*|assert_ne!|isNot\w+)$/
// Direct assertion calls whose first two arguments are the operands (the
// rest is a message): Node assert, unittest, XCTest, Rust, PHPUnit.
const DIRECT = /^(assert\.\w+|(self\.)?assert\w+|XCTAssert\w+|assert_eq!|assert_ne!|\$this->assert\w+)\s*\($/

function values(s: Scanned): Values {
  // Whitespace is dropped from code only; literal bodies come back exactly.
  const resolve = (t: string) =>
    t.replace(/\s+/g, '').replace(/,([}\])])/g, '$1').replace(/"§(\d+)"/g, (_, k: string) => JSON.stringify(s.literals[Number(k)] ?? ''))
  const expected: Expected[] = []
  let constants = 0
  for (const m of s.code.matchAll(EXACT)) {
    const text = m[0]
    const at = m.index ?? 0
    const name = /([\w!#]+)\s*\($/.exec(text)?.[1] ?? text
    const before = s.code.slice(Math.max(0, at - 6), at)
    const negated = /\.not$/.test(before) || /\.not\./.test(text) || /\.(not_to|to_not)\s/.test(text) || NEGATED_MATCHER.test(name)
    const implied = /\.(toBeNull|toBeUndefined|toBeNaN)\s*\($/.exec(text)
    if (implied !== null) {
      expected.push({ value: implied[1] === 'toBeNull' ? 'null' : implied[1] === 'toBeNaN' ? 'NaN' : 'undefined', negated, rank: 4 })
      continue
    }
    if (!text.endsWith('(')) continue
    let args = topLevel(argsFrom(s.code, at + text.length))
    const direct = DIRECT.test(text.replace(/^\./, ''))
    if (direct) {
      args = args.slice(0, 2)
      if (args.length === 2 && args.every(isLiteral)) constants += 1
    }
    const relation = RELATION.find(([re]) => re.test(name))?.[1]
    if (relation === '~') {
      // toBeCloseTo(3) and toBeCloseTo(3, 2) are the same bound; fewer digits is looser.
      const [value, digits = '2'] = args
      if (value !== undefined && isLiteral(value)) expected.push({ value: `~${resolve(value)}@${resolve(digits)}`, negated, rank: 1 })
      continue
    }
    for (const arg of args) {
      if (isLiteral(arg)) expected.push({ value: `${relation ?? ''}${resolve(arg)}`, negated, rank: rank(name) })
    }
  }
  // Python's bare assert, parenthesized across lines or to the end of the line:
  // each comparison keeps its operator, so == 3 → != 3 is a change.
  for (const m of s.code.matchAll(/^[ \t]*assert\b[ \t]*/gm)) {
    const at = (m.index ?? 0) + m[0].length
    const expr = s.code[at] === '(' ? argsFrom(s.code, at + 1) : (s.code.slice(at).split('\n')[0] ?? '')
    const body = expr.split(/,(?![^()[\]{}]*[)\]}])/)[0] ?? ''
    for (const clause of body.split(/\band\b|\bor\b/)) {
      // a < n < b is two comparisons; each keeps its own operator.
      const parts = clause.trim().split(/(==|!=|<=|>=|<|>|\bnot\s+in\b|\bin\b|\bis\s+not\b|\bis\b)/)
      for (let k = 1; k + 1 < parts.length; k += 2) {
        const [left = '', op = '', right = ''] = [parts[k - 1], parts[k], parts[k + 1]]
        if (isLiteral(left) && isLiteral(right)) constants += 1
        const negated = /!=|not/.test(op)
        const key = op.replace(/\s+/g, ' ').replace('!=', '==').replace(/not /, '')
        if (isLiteral(left)) expected.push({ value: `${resolve(left)} ${key}`, negated, rank: /[<>]/.test(op) ? 1 : 3 })
        if (isLiteral(right)) expected.push({ value: `${key} ${resolve(right)}`, negated, rank: /[<>]/.test(op) ? 1 : 3 })
      }
    }
  }
  // expect(<literal>).matcher(<literal or nothing>): it can only ever pass.
  for (const m of s.code.matchAll(/\bexpect(\.soft)?\s*\(/g)) {
    const start = (m.index ?? 0) + m[0].length
    const subject = argsFrom(s.code, start)
    if (!isLiteral(subject)) continue
    const tail = /^\s*(\.\s*\w+\s*)*?\.\s*\w+\s*\(/.exec(s.code.slice(start + subject.length + 1))
    if (tail === null) continue
    const matcherArgs = argsFrom(s.code, start + subject.length + 1 + tail[0].length)
    if (matcherArgs.trim() === '' || topLevel(matcherArgs).every(isLiteral)) constants += 1
  }
  // Rows of literal test data: flat literal groups that sit inside a list or
  // table (test.each rows, Go table cases), not option objects passed to a call.
  const rows: string[] = []
  const stack: string[] = []
  for (let i = 0; i < s.code.length; i += 1) {
    const c = s.code[i]!
    if (c === '[' || c === '{' || c === '(') {
      const enclosing = stack[stack.length - 1]
      // A { after ), => or a keyword/type name opens a block (a function body,
      // if/else/try, struct{...}), not a literal: nothing inside it is a row.
      const block = c === '{' && /[)>\w]$/.test(s.code.slice(0, i).trimEnd())
      if (block) {
        stack.push('B')
        continue
      }
      if (c !== '(' && (enclosing === '[' || enclosing === '{')) {
        const body = argsFrom(s.code, i + 1)
        if (body.includes(',') && !/[{[(]/.test(body) && isLiteral(body)) rows.push(resolve(`${c}${body}`))
      }
      stack.push(c)
    } else if (c === ']' || c === '}' || c === ')') stack.pop()
  }
  return { expected, rows, constants }
}

// try { ...assertion... } catch (...) { ...no rethrow, no fail... } and the
// Python and Ruby equivalents, plus pytest.raises(AssertionError) and
// expect(() => expect(...)).toThrow(): the assertion can no longer fail the test.
function swallowed(code: string): number {
  let n = 0
  for (const m of code.matchAll(/\btry\s*\{/g)) {
    const tryAt = (m.index ?? 0) + m[0].length
    const body = argsFrom(code, tryAt)
    const after = code.slice(tryAt + body.length + 1)
    const katch = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(after)
    if (katch === null) continue
    const handler = argsFrom(after, katch[0].length)
    if (count(body, ASSERTION) > 0 && !/\bthrow\b|\bfail\s*\(|\bdone\s*\(\s*\w/.test(handler)) n += 1
  }
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const tryLine = /^([ \t]*)try:\s*$/.exec(lines[i] ?? '')
    if (tryLine === null) continue
    const indent = tryLine[1] ?? ''
    let j = i + 1
    const body: string[] = []
    while (j < lines.length && ((lines[j] ?? '').startsWith(`${indent} `) || (lines[j] ?? '').startsWith(`${indent}\t`) || (lines[j] ?? '').trim() === '')) body.push(lines[j++] ?? '')
    const except = new RegExp(`^${indent}except\\b[^:]*:(.*)$`).exec(lines[j] ?? '')
    if (except === null) continue
    const handler = [except[1] ?? '']
    j += 1
    while (j < lines.length && ((lines[j] ?? '').startsWith(`${indent} `) || (lines[j] ?? '').startsWith(`${indent}\t`))) handler.push(lines[j++] ?? '')
    if (count(body.join('\n'), ASSERTION) > 0 && !/\braise\b|\bpytest\.fail\b|\bself\.fail\b/.test(handler.join('\n'))) n += 1
  }
  for (const m of code.matchAll(/^([ \t]*)begin[ \t]*\n((?:.*\n)*?)\1rescue\b[^\n]*\n((?:.*\n)*?)\1end\b/gm)) {
    if (count(m[2] ?? '', ASSERTION) > 0 && !/\braise\b|\bflunk\b|\bfail\b/.test(m[3] ?? '')) n += 1
  }
  n += count(code, /\bwith\s+pytest\.raises\s*\(\s*(AssertionError|Exception|BaseException)\b|\bassertRaises\s*\(\s*(AssertionError|Exception|BaseException)\b|\bexpect\s*\(\s*(async\s*)?\(\s*\)\s*=>\s*\{?\s*(await\s+)?expect\b|\bXCTAssertThrows\w*\s*\(\s*XCTAssert/g)
  return n
}

const norm = (line: string) => line.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()

type Measure = Scanned &
  Values & {
    assertions: number
    skips: number
    focus: number
    cases: number
    exact: number
    vague: number
    negations: number
    trivial: number
    swallow: number
    disabled: number
  }

export function measure(text: string, path: string): Measure {
  const s = scan(text, HASH_COMMENT.test(path))
  return {
    ...s,
    ...values(s),
    assertions: count(s.code, ASSERTION),
    skips: count(s.code, SKIP),
    focus: count(s.code, FOCUS),
    cases: count(s.code, CASE),
    exact: count(s.code, EXACT),
    vague: count(s.code, VAGUE_ONLY),
    negations: count(s.code, NEGATION),
    trivial: count(s.code, TRIVIAL),
    swallow: swallowed(s.code),
    disabled: count(s.code, DISABLED),
  }
}

function missing(before: string[], after: string[]): string[] {
  const left = new Map<string, number>()
  for (const v of after) left.set(v, (left.get(v) ?? 0) + 1)
  const gone: string[] = []
  for (const v of before) {
    const k = left.get(v) ?? 0
    if (k > 0) left.set(v, k - 1)
    else gone.push(v)
  }
  return gone
}

// Old expected values with no new assertion pinning the same value, with the
// same polarity, at least as strictly.
function weakened(before: Expected[], after: Expected[]): string[] {
  const pool = [...after]
  const gone: string[] = []
  for (const old of [...before].sort((x, y) => y.rank - x.rank)) {
    // A stricter positive matcher is stronger; under .not it is easier to
    // satisfy, so a negated one must keep its exact strictness.
    const covers = (n: Expected) => n.value === old.value && n.negated === old.negated && (old.negated ? n.rank === old.rank : n.rank >= old.rank)
    const at = pool.findIndex(covers)
    if (at >= 0) pool.splice(at, 1)
    else {
      const looser = pool.some(n => n.value === old.value && n.negated === old.negated)
      const flipped = pool.some(n => n.value === old.value && n.negated !== old.negated)
      gone.push(`${old.negated ? 'not ' : ''}${old.value}${flipped ? ' (polarity flipped)' : looser ? ' (looser matcher)' : ''}`)
    }
  }
  return gone
}

// Source lines that held an assertion before and now reappear as comments.
function commentedOut(before: string, a: Measure, b: Measure, after: string): number {
  const original = before.split('\n')
  const bCode = b.code.split('\n')
  const stillCode = new Set(after.split('\n').filter((_, i) => /\S/.test(bCode[i] ?? '')).map(norm))
  const gone = new Set<string>()
  a.code.split('\n').forEach((line, i) => {
    if (count(line, ASSERTION) > 0) {
      const src = norm(original[i] ?? '')
      if (!stillCode.has(src)) gone.add(src)
    }
  })
  return b.comments.map(norm).filter(c => gone.has(c)).length
}

const show = (list: string[]) => {
  const q = (v: string) => `\`${v.length > 40 ? `${v.slice(0, 39)}…` : v}\``
  return list.slice(0, 3).map(q).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '')
}

// Each signal names what got weaker. Adding tests, moving or reordering
// assertions, renaming and stronger matchers leave every measure level or
// higher and every old expected value and data row present, so they pass.
export function weakening(before: string, after: string, path: string): string[] {
  if (isSnapshot(path)) {
    return before.trim() !== '' && before !== after ? ['snapshot file rewritten by hand'] : []
  }
  const a = measure(before, path)
  const b = measure(after, path)
  const added = Math.max(0, b.assertions - a.assertions)
  const signals: string[] = []
  if (b.cases < a.cases) signals.push(`test cases deleted (${a.cases} → ${b.cases})`)
  if (b.assertions < a.assertions) signals.push(`assertions removed (${a.assertions} → ${b.assertions})`)
  const commented = commentedOut(before, a, b, after)
  if (commented > 0) signals.push(`assertions commented out (${commented})`)
  if (b.skips > a.skips) signals.push(`tests skipped, marked todo or expected to fail (+${b.skips - a.skips})`)
  if (b.focus > a.focus) signals.push(`focus added (.only/fit), which silently skips every other test (+${b.focus - a.focus})`)
  if (b.exact < a.exact && b.assertions >= a.assertions) signals.push(`exact matchers replaced (${a.exact} → ${b.exact})`)
  if (b.vague - a.vague > added) signals.push(`vague matchers added (toBeTruthy/toBeDefined/expect.anything/expect.any) (+${b.vague - a.vague})`)
  if (b.negations !== a.negations && Math.abs(b.negations - a.negations) > added) {
    signals.push(`assertion polarity flipped (.not / notEqual / assert_ne!: ${a.negations} → ${b.negations})`)
  }
  if (b.trivial > a.trivial || b.constants > a.constants) {
    signals.push(`constant assertions added, e.g. expect(3).toBe(3), assert 3 == 3 (+${b.trivial - a.trivial + b.constants - a.constants})`)
  }
  if (b.swallow > a.swallow) signals.push(`assertion failures swallowed by a catch/except that does not rethrow (+${b.swallow - a.swallow})`)
  if (b.disabled > a.disabled) signals.push(`assertions disabled by a dead branch or early return (+${b.disabled - a.disabled})`)
  const gone = weakened(a.expected, b.expected)
  if (gone.length > 0) signals.push(`expected values changed, loosened or dropped: ${show(gone)}`)
  const rows = missing(a.rows, b.rows)
  if (rows.length > 0) signals.push(`test data rows removed or changed: ${show(rows)}`)
  return signals
}

// ---------------------------------------------------------------------------
// Bash

// Splits a command line into simple commands and their words, quotes removed.
// The string of `bash -c` / `sh -c` and backtick substitutions are split too.
export function commands(line: string, depth = 0): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let quote: string | null = null
  const push = () => {
    if (word !== '') words.push(word)
    word = ''
  }
  const end = () => {
    push()
    if (words.length > 0) out.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!
    if (quote !== null) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') word += line[(i += 1)] ?? ''
      else word += c
    } else if (c === '"' || c === "'") quote = c
    else if (c === '\\') word += line[(i += 1)] ?? ''
    else if (c === ';' || c === '\n' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') end()
    else if (c === '$' && line[i + 1] === '(') {
      end()
      i += 1
    } else if (c === '>' || c === '<') {
      push()
      let op = c
      while (line[i + 1] === '>' || line[i + 1] === '&') op += line[(i += 1)]
      words.push(op)
    } else if (/\s/.test(c)) push()
    else word += c
  }
  end()
  if (depth < 3) {
    for (const words of [...out]) {
      const head = base(words[0])
      const at = words.indexOf('-c')
      if (/^(bash|sh|zsh|dash)$/.test(head) && at > 0 && words[at + 1] !== undefined) out.push(...commands(words[at + 1]!, depth + 1))
    }
  }
  return out
}

const base = (w: string | undefined) => (w ?? '').split('/').pop() ?? ''

// Drops env assignments and wrappers that run another command: env, time,
// nice, npx/bunx/pnpm exec/yarn dlx (and their flags), python -m.
function unwrap(words: string[]): string[] {
  let w = words.filter(x => !/^[A-Za-z_]+=/.test(x))
  for (let guard = 0; guard < 6; guard += 1) {
    const head = base(w[0])
    if (head === 'sudo' || head === 'doas') {
      w = w.slice(1)
      while (w[0] !== undefined && w[0].startsWith('-')) w = w.slice(w[0] === '-u' || w[0] === '-g' ? 2 : 1)
    } else if (head === 'yarn' && w[1] === 'workspace') w = ['yarn', ...w.slice(3)]
    else if (/^(npm|pnpm|yarn|bun)$/.test(head) && ['exec', 'dlx', 'x'].includes(script(w, true) ?? '')) {
      const at = w.findIndex((x, i) => i > 0 && ['exec', 'dlx', 'x'].includes(x))
      w = w.slice(at + 1).filter((x, i) => !(i === 0 && x === '--'))
    } else if (/^(env|time|nice|nohup|command|exec)$/.test(head)) {
      w = w.slice(1)
      while (w[0] !== undefined && (/^[A-Za-z_]+=/.test(w[0]) || w[0].startsWith('-'))) w = w.slice(1)
    }
    else if (/^(npx|bunx|pnpx)$/.test(head)) w = w.slice(1).filter((x, i, all) => !(x.startsWith('-') && i < all.findIndex(y => !y.startsWith('-'))))
    else if (/^python[\d.]*$/.test(head) && w[1] === '-m') w = w.slice(2)
    else break
  }
  return w
}

// Package-manager flags that take a value (`pnpm --filter app test`).
const VALUE_FLAGS = new Set(['--filter', '-F', '--prefix', '-C', '--dir', '--cwd', '--workspace', '-w'])

// The script or subcommand a package manager runs, past its own flags.
function script(words: string[], raw = false): string | undefined {
  const rest: string[] = []
  for (let i = 1; i < words.length; i += 1) {
    const x = words[i]!
    if (VALUE_FLAGS.has(x)) i += 1
    else if (!x.startsWith('-')) rest.push(x)
  }
  if (raw) return rest[0]
  return rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0]
}

const RUNNER = /^(jest|vitest|playwright|pytest|py\.test|react-native-owl)$/
const UPDATE_FLAG = /^(-u|--updateSnapshot(=true)?|--update-snapshots?(=\w+)?|--snapshot-update|--update|--force-regen)$/

// A simple command that rewrites snapshots.
export function snapshotUpdate(words: string[]): boolean {
  const env = words.filter(x => /^[A-Za-z_]+=/.test(x))
  if (env.some(x => /^(INSTA_UPDATE=(1|always|new)|UPDATE_SNAPSHOTS?=(1|true)|SNAPSHOT_UPDATE=(1|true))$/.test(x))) return true
  const w = unwrap(words)
  const head = base(w[0])
  if (head === 'cargo' && w[1] === 'insta' && (w[2] === 'accept' || w[2] === 'review')) return true
  if (head === 'loki' && w[1] === 'update') return true
  if (head === 'backstop' && w[1] === 'approve') return true
  if (head === 'chromatic' && w.includes('--auto-accept-changes')) return true
  if (!w.some(x => UPDATE_FLAG.test(x))) return false
  if (RUNNER.test(head)) return true
  // node node_modules/jest/bin/jest.js -u
  if (/^(node|bun|deno)$/.test(head) && /(^|\/)(jest|vitest|playwright)(\/|\.|$)/.test(w[1] ?? '')) return true
  // npm test -- -u, yarn test -u, pnpm --filter app run test:unit -u
  if (/^(npm|pnpm|yarn|bun)$/.test(head)) return /^(test|jest|vitest|e2e|spec)([:\w-]*)$/.test(script(w) ?? '')
  return false
}

const WRITERS = /^(rm|mv|truncate|tee|unlink|shred|patch)$/
const SCRIPTS = /^(python[\d.]*|node|ruby|perl|deno|bun)$/
const isTestTarget = (w: string) => isTestFile(w) || TEST_DIR_OPERAND.test(w.replace(/\/?\*+$/, '')) || isTestFile(w.replace(/\*/g, 'x'))

// Test files or test directories a simple command writes, moves, deletes or rolls back.
export function shellWrites(words: string[]): string[] {
  const w = unwrap(words)
  const head = base(w[0])
  const operands = (list: string[]) => list.filter(x => !x.startsWith('-') && isTestTarget(x))
  const hits = new Set<string>()
  w.forEach((x, i) => {
    if (/^(>{1,2}|&>{1,2}|>&|>\|)$/.test(x) && w[i + 1] !== undefined && isTestFile(w[i + 1]!)) hits.add(w[i + 1]!)
  })
  if (WRITERS.test(head)) operands(w.slice(1)).forEach(t => hits.add(t))
  if (head === 'cp' || head === 'dd' || head === 'install' || head === 'rsync') {
    const dest = head === 'dd' ? w.find(x => x.startsWith('of='))?.slice(3) : w[w.length - 1]
    if (dest !== undefined && w.length > 2 && isTestFile(dest)) hits.add(dest)
  }
  if (head === 'git') {
    // git -C dir / -c key=value come before the subcommand.
    const g = ['git']
    for (let i = 1; i < w.length; i += 1) {
      if ((w[i] === '-C' || w[i] === '-c') && g.length === 1) i += 1
      else g.push(w[i]!)
    }
    const sub = g[1]
    const dashes = g.indexOf('--')
    const paths = dashes > 0 ? g.slice(dashes + 1) : g.slice(2).filter(x => !x.startsWith('-'))
    if (sub === 'rm' || sub === 'mv') operands(g.slice(2)).forEach(t => hits.add(t))
    if (sub === 'checkout') {
      // `git checkout <rev> [--] file`, `--theirs/--ours`: the file is replaced
      // by another version. `git checkout [--] file` only restores HEAD's.
      const opts = g.slice(2, dashes > 0 ? dashes : undefined)
      const rev = opts.find(x => !x.startsWith('-') && !isTestTarget(x))
      const side = opts.some(x => x === '--theirs' || x === '--ours')
      if (side || (rev !== undefined && rev !== 'HEAD')) operands(paths.filter(x => x !== rev)).forEach(t => hits.add(t))
    }
    if (sub === 'restore') {
      const at = g.findIndex(x => x === '--source' || x === '-s')
      const source = g.find(x => x.startsWith('--source='))?.slice(9) ?? (at > 0 ? g[at + 1] : undefined)
      if (source !== undefined && source !== 'HEAD') operands(paths.filter(x => x !== source)).forEach(t => hits.add(t))
    }
  }
  if ((head === 'sed' || head === 'perl') && w.some(x => /^-[a-zA-Z]*i/.test(x) || x.startsWith('--in-place'))) {
    operands(w.slice(1)).forEach(t => hits.add(t))
  }
  const execs = w.flatMap((x, i) => (x === '-exec' || x === '-execdir' ? [base(w[i + 1])] : []))
  if (head === 'find' && (w.includes('-delete') || execs.some(x => /^(rm|sed|perl|mv|truncate|tee|shred)$/.test(x)))) {
    // Roots come before the first option; patterns follow -name/-path.
    const firstOption = w.findIndex((x, i) => i > 0 && x.startsWith('-'))
    const roots = w.slice(1, firstOption < 0 ? undefined : firstOption).filter(x => TEST_DIR_OPERAND.test(x))
    const patterns = w.flatMap((x, i) => (/^-(i?name|i?path|regex)$/.test(x) && w[i + 1] !== undefined ? [w[i + 1]!] : []))
    patterns.filter(isTestTarget).forEach(t => hits.add(t))
    // Inside a test folder, deleting code files (or everything) deletes tests.
    const code = patterns.length === 0 || patterns.some(x => CODE_FILE.test(x.replace(/\*/g, 'x')))
    if (code) roots.forEach(t => hits.add(t))
  }
  if (SCRIPTS.test(head) && w.some(x => /^-[ce]$/.test(x))) {
    // A one-liner naming a test file: it may well write it.
    for (const x of w) {
      for (const m of x.matchAll(/[\w./-]+/g)) {
        const named = m[0]
        if (isTestFile(named) && (named.includes('/') || /\.(test|spec)\./.test(named))) hits.add(named)
      }
    }
  }
  return [...hits]
}

export function bashSignals(command: string): string[] {
  const signals: string[] = []
  const all = commands(command)
  if (all.some(snapshotUpdate)) {
    signals.push('bulk snapshot update: every failing snapshot is rewritten to match the current output')
  }
  const written = [...new Set(all.flatMap(shellWrites))]
  if (written.length > 0) {
    signals.push(`test files changed through the shell, where the change cannot be checked: ${written.slice(0, 3).join(', ')}`)
  }
  return signals
}

// ---------------------------------------------------------------------------
// Tools

// Applies an Edit to the file's text as the tool would.
export function applyEdit(text: string, oldString: string, newString: string, all: boolean): string | null {
  if (!text.includes(oldString)) return null
  return all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
}

type Cell = { id?: string; cell_type?: string; source?: string | string[] }
type Notebook = { cells?: Cell[]; metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } }

// Old and new source of the notebook code cell a NotebookEdit touches, and
// the path to analyze it as (its language's extension). `skip`: a markdown
// cell, nothing to check. `null`: the cell it names is not there.
export function notebookChange(
  notebook: string,
  path: string,
  e: { cell_id?: string; new_source: string; edit_mode?: string; cell_type?: string },
): { before: string; after: string; as: string } | 'skip' | null {
  let parsed: Notebook = {}
  try {
    parsed = JSON.parse(notebook) as Notebook
  } catch {
    parsed = {}
  }
  const lang = parsed.metadata?.language_info?.name ?? parsed.metadata?.kernelspec?.language ?? 'python'
  const as = lang.toLowerCase().startsWith('py') ? `${path}.py` : path
  const cells = parsed.cells ?? []
  const source = (c: Cell) => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? ''))
  if (e.edit_mode === 'insert') return e.cell_type === 'markdown' ? 'skip' : { before: '', after: e.new_source, as }
  const cell = cells.find(c => c.id === e.cell_id)
  if (cell === undefined) return null
  if (cell.cell_type === 'markdown' && e.cell_type !== 'code') return 'skip'
  // A code cell deleted, or turned into markdown, no longer runs.
  if (e.edit_mode === 'delete' || e.cell_type === 'markdown') return { before: source(cell), after: '', as }
  return { before: cell.cell_type === 'markdown' ? '' : source(cell), after: e.new_source, as }
}
