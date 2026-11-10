import { describe, expect, it } from 'vitest';
import { orIlikeAny, orIlikeContains } from './search-escape';

describe('orIlikeContains', () => {
  it('quotes the value so commas and parentheses stay literal', () => {
    expect(orIlikeContains('Smith, Inc')).toBe('"%Smith, Inc%"');
    expect(orIlikeContains('Acme (US)')).toBe('"%Acme (US)%"');
  });

  it('escapes double quotes and backslashes', () => {
    expect(orIlikeContains('The "Best" Co')).toBe('"%The \\"Best\\" Co%"');
    expect(orIlikeContains('a\\b')).toBe('"%a\\\\b%"');
  });
});

describe('orIlikeAny', () => {
  it('builds one ilike condition per column', () => {
    expect(orIlikeAny(['company_name', 'name'], 'Smith, Inc')).toBe(
      'company_name.ilike."%Smith, Inc%",name.ilike."%Smith, Inc%"',
    );
  });
});
