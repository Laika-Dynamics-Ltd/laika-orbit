import { describe, expect, it } from 'vitest'
import { destructive, firstWrite, head, readOnly, statements, strip } from '../src/sql.ts'

/**
 * The read-only guard. This is what stands between a mistyped statement and a real database, so
 * the cases that matter are the ones where the text *looks* like one thing and does another:
 * a keyword inside a string or a comment, a write hidden in a CTE, `explain analyze`.
 *
 * It is lexical and says so — these tests pin what it catches, not a claim that nothing gets past.
 */
describe('strip', () => {
  it('blanks line and block comments, keeping the length', () => {
    const sql = "select 1 -- delete from t\nfrom x"
    expect(strip(sql)).toHaveLength(sql.length)
    expect(strip(sql)).not.toMatch(/delete/)
    expect(strip('select /* drop table t */ 1')).not.toMatch(/drop/)
  })

  it('handles nested block comments', () => {
    expect(strip('select /* a /* delete */ b */ 1')).not.toMatch(/delete/)
  })

  it('blanks string literals, including escaped quotes', () => {
    expect(strip("select 'delete from users'")).not.toMatch(/delete/)
    expect(strip("select 'it''s a drop' , 2")).not.toMatch(/drop/)
    expect(strip('select "drop table" from t')).not.toMatch(/drop/)
  })

  it('blanks dollar-quoted bodies', () => {
    expect(strip('select $$ delete from t $$')).not.toMatch(/delete/)
    expect(strip('select $fn$ truncate x $fn$')).not.toMatch(/truncate/)
  })
})

describe('statements', () => {
  it('splits on semicolons outside quotes and comments', () => {
    expect(statements('select 1; select 2')).toEqual(['select 1', 'select 2'])
    expect(statements("select ';'; select 2")).toEqual(["select ';'", 'select 2'])
    expect(statements('select 1; -- ; not a statement\n')).toEqual(['select 1', '-- ; not a statement'])
  })

  it('ignores a trailing semicolon and blank statements', () => {
    expect(statements('select 1;')).toEqual(['select 1'])
    expect(statements(' ;; ')).toEqual([])
  })

  it('reads the leading keyword past brackets', () => {
    expect(head('  (select 1) union select 2')).toBe('select')
    expect(head('WITH x as (select 1) select * from x')).toBe('with')
  })
})

describe('readOnly', () => {
  it('passes plain reads', () => {
    for (const sql of [
      'select * from users limit 10',
      'SELECT count(*) FROM "public"."orders"',
      'with recent as (select * from events limit 5) select * from recent',
      'explain select * from users',
      'show search_path',
      'table users',
      'values (1), (2)',
      '(select 1) union (select 2)',
      'select 1; select 2;',
    ]) {
      expect(readOnly(sql), sql).toBe(true)
    }
  })

  it('refuses writes, DDL and anything with a side effect', () => {
    for (const sql of [
      'delete from users',
      'update users set name = null',
      'insert into users (id) values (1)',
      'drop table users',
      'truncate users',
      'alter table users add column x int',
      'create index on users (id)',
      'grant all on users to anon',
      'call do_something()',
      'do $$ begin delete from t; end $$',
      'vacuum full',
      'refresh materialized view m',
      'set role postgres',
    ]) {
      expect(readOnly(sql), sql).toBe(false)
    }
  })

  it('refuses a write hidden in a CTE', () => {
    expect(readOnly('with gone as (delete from users returning *) select * from gone')).toBe(false)
    expect(readOnly('with x as (insert into t values (1) returning *) select * from x')).toBe(false)
  })

  it('refuses explain analyze, which runs the statement', () => {
    expect(readOnly('explain analyze delete from users')).toBe(false)
    expect(readOnly('EXPLAIN (ANALYZE, BUFFERS) update users set x = 1')).toBe(false)
    expect(readOnly('explain (costs off) select 1')).toBe(true)
  })

  it('refuses a batch where any one statement writes', () => {
    expect(readOnly('select 1; delete from users; select 2')).toBe(false)
  })

  it('is not fooled by a keyword in a string or a comment', () => {
    expect(readOnly("select * from posts where body = 'drop table users'")).toBe(true)
    expect(readOnly('select 1 -- delete from users')).toBe(true)
    // and not fooled the other way: a comment before the statement does not hide it
    expect(readOnly('-- harmless\ndelete from users')).toBe(false)
  })

  it('refuses an empty script rather than sending nothing', () => {
    expect(readOnly('   ')).toBe(false)
    expect(readOnly('-- just a comment')).toBe(false)
  })

  it('names the first statement that is not a read', () => {
    expect(firstWrite('select 1; truncate users')).toBe('TRUNCATE')
    expect(firstWrite('select 1')).toBeNull()
  })
})

describe('destructive', () => {
  it('flags whole tables going away', () => {
    expect(destructive('drop table users')).toBe('DROP TABLE')
    expect(destructive('truncate users')).toBe('TRUNCATE')
    expect(destructive('alter table users drop column email')).toBe('ALTER … DROP')
  })

  it('flags the missing WHERE, and only the missing one', () => {
    expect(destructive('delete from users')).toBe('DELETE with no WHERE')
    expect(destructive('update users set banned = true')).toBe('UPDATE with no WHERE')
    expect(destructive('delete from users where id = 1')).toBeNull()
    expect(destructive("update users set x = 1 where id = 'where'")).toBeNull()
  })

  it('leaves ordinary writes and reads alone', () => {
    expect(destructive('insert into users (id) values (1)')).toBeNull()
    expect(destructive('select * from users')).toBeNull()
  })
})
