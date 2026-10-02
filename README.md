# Assertion Guardian

![Assertion Guardian demo](media/demo.gif)

_The model is asked to change an expected value so a failing test passes. Assertion Guardian refuses and names the signal, the band above the prompt offers **allow once**, and the real bug gets fixed instead. [MP4](media/demo.mp4)_

A Claude Code mod that stops the agent from making tests pass by making the tests weaker.

Before any Edit, Write or NotebookEdit to a test file runs, the mod works out the whole file before and after the change. It refuses the change if the tests got weaker. A light scanner first separates code from comments and string literals, so an `expect(` inside a docstring, a comment or a fixture string is never counted as code.

| Signal | Example |
|---|---|
| Assertions removed | `expect(...)`, `assert`, `assert.strictEqual`, `XCTAssert*`, `assertThat`, `t.Error`, `#expect` |
| Test cases deleted | `it(...)`, `test(...)`, `def test_*`, `func Test*`, `@Test` |
| Expected values changed or dropped | Jest, Node `assert`, unittest/pytest, AssertJ, chai, RSpec, XCTest: `toBe(3)` changed to `toBe(4)`, `toHaveBeenCalledWith(1)` changed to `toHaveBeenCalled()`, an edited inline snapshot, `assert f() == 1` changed to `== 2` |
| Exact matchers replaced or loosened | `toBe(3)` changed to `toBeTruthy()`, `toBeGreaterThanOrEqual(3)` or `toBeCloseTo(3)`, `toStrictEqual` changed to `toEqual`, `toBeGreaterThan(3)` changed to `toBeGreaterThanOrEqual(3)` or `toBeLessThan(3)`, `toBeCloseTo(3)` changed to `toBeCloseTo(3, 0)` |
| Vague matchers added | `toEqual(0)` changed to `toEqual(expect.any(Number))` |
| Constant assertions added | `expect(3).toBe(3)`, `assert.strictEqual(3, 3)`, `assert 3 == 3`, `XCTAssertEqual(3, 3)`, `assert True` |
| Assertion polarity flipped | `.toBe(3)` changed to `.not.toBe(3)`, `strictEqual` changed to `notStrictEqual`, `assert x == 3` changed to `!= 3`, `is None` changed to `is not None` |
| Test data rows removed | a row deleted from a Go table test or a `test.each` table |
| Skips added | `it.skip`, `xit`, `it.todo`, `test.fail`, `this.skip()`, `@pytest.mark.skip/xfail`, `@Disabled`, `@Ignore`, `t.Skip`, `XCTSkip` |
| Focus added | `.only` / `fit(`, which silently drops every other test |
| Assertions commented out | a line that held an assertion reappears as a comment |
| Assertion failures swallowed | a `try` around an assertion whose `catch` / `except` / `rescue` doesn't rethrow, `pytest.raises(AssertionError)`, `expect(() => expect(...)).toThrow()` |
| Dead branches | `if (false) { expect(...) }`, `return` before the assertions |
| Snapshot files rewritten by hand | `*.snap`, `__snapshots__/` |
| Snapshots updated in bulk | `jest -u`, `npm test -- -u`, `--update-snapshots`, `cargo insta accept`, `INSTA_UPDATE=1`, `loki update`, `backstop approve`, `chromatic --auto-accept-changes`. Wrappers such as `env`, `npx`, `pnpm exec`, `pnpm --filter` and `python -m` are looked through |
| Test files changed through the shell | `rm`, `mv`, `sed -i`, `perl -pi`, `>` redirects, `tee`, `git rm`, `rm -rf tests`, `find ... -delete`, `git checkout <rev> -- file`, `bash -c "..."`, one-off `python -c` / `node -e` scripts that name a test file |

Suppose a test file has been deleted and is then written again from scratch. The new version is compared with what git last committed, so deleting the file doesn't get around the check.

The refusal lists which signals fired. It tells the model to fix the code under test, or to ask you if it thinks the test itself is wrong.

Normal refactors pass: renaming the value under test, reformatting, reordering, moving assertions between tests, adding tests, switching quote style, swapping in stronger matchers, and changing `toBe(null)` to `toBeNull()`.

**Override:** a band above the prompt shows the last blocked change, with **allow once** and **dismiss** buttons. Or run `/allow-test-change`, which runs immediately, even mid-turn. An allowance is tied to that exact call (same tool, same file, same content), so the model has to retry the identical change. A different edit to the same file is checked from scratch.

This is a guardrail, not a sandbox. It checks what tool calls say they'll do. A determined process could still change files some other way, such as a script that never names the test file.

Test files are recognised by `*.test.*`, `*.spec.*`, `test_*.py`, `tests.py`, `*_test.{py,go,rb,ex,dart}`, `*_spec.rb`, `*Tests.swift`, `*Test.{kt,java,cs}`, and snapshot paths. Code files under `__tests__/`, `test/`, `tests/` or `spec/` count too, except those inside `fixtures/`, `support/`, `helpers/`, `factories/`, `__mocks__/` or `testdata/`.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install assertion-guardian@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```
