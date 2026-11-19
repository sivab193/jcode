import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCodexToml, mergeJsonMcpServers } from '../dist/mcp/install.js';

const ENTRY = { command: 'node', args: ['/x/dist/mcp/server.js'] };

test('mergeJsonMcpServers: fresh config gets the entry', () => {
  const merged = mergeJsonMcpServers(null, 'mcpServers', ENTRY);
  assert.ok(merged);
  const parsed = JSON.parse(merged);
  assert.deepEqual(parsed.mcpServers['scode-tools'], ENTRY);
});

test('mergeJsonMcpServers: existing servers are preserved', () => {
  const existing = JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }, null, 2);
  const merged = mergeJsonMcpServers(existing, 'mcpServers', ENTRY);
  assert.ok(merged);
  const parsed = JSON.parse(merged);
  assert.deepEqual(parsed.mcpServers.other, { command: 'other' });
  assert.deepEqual(parsed.mcpServers['scode-tools'], ENTRY);
  assert.equal(parsed.theme, 'dark');
});

test('mergeJsonMcpServers: invalid JSON returns null (never clobber)', () => {
  assert.equal(mergeJsonMcpServers('{not json', 'mcpServers', ENTRY), null);
});

test('mergeJsonMcpServers: opencode uses the mcp key', () => {
  const merged = mergeJsonMcpServers('{}', 'mcp', { type: 'local', command: ['node', '/x/server.js'] });
  assert.ok(merged);
  const parsed = JSON.parse(merged);
  assert.equal(parsed.mcp['scode-tools'].type, 'local');
});

test('mergeCodexToml: appends to an empty config', () => {
  const merged = mergeCodexToml(null, 'node', ['/x/server.js']);
  assert.match(merged, /\[mcp_servers\.scode-tools\]/);
  assert.match(merged, /command = "node"/);
  assert.match(merged, /"\/x\/server\.js"/);
});

test('mergeCodexToml: preserves other sections', () => {
  const existing = '[mcp_servers.other]\ncommand = "other"\n\n[model]\nname = "gpt"\n';
  const merged = mergeCodexToml(existing, 'node', ['/x/server.js']);
  assert.match(merged, /\[mcp_servers\.other\]/);
  assert.match(merged, /\[model\]/);
  assert.match(merged, /\[mcp_servers\.scode-tools\]/);
});

test('mergeCodexToml: replaces an existing scode-tools section in place', () => {
  const existing = '[mcp_servers.scode-tools]\ncommand = "node"\nargs = ["/old/server.js"]\n\n[other]\nx = 1\n';
  const merged = mergeCodexToml(existing, 'node', ['/new/server.js']);
  assert.doesNotMatch(merged, /\/old\/server\.js/);
  assert.match(merged, /\/new\/server\.js/);
  assert.match(merged, /\[other\]/);
  assert.equal((merged.match(/\[mcp_servers\.scode-tools\]/g) ?? []).length, 1);
});

test('mergeJsonMcpServers: drops the legacy jcode-tools entry', () => {
  const existing = JSON.stringify({ mcpServers: { 'jcode-tools': { command: 'node', args: ['/old/server.js'] }, other: { command: 'x' } } });
  const merged = mergeJsonMcpServers(existing, 'mcpServers', { command: 'node', args: ['/new/server.js'] });
  assert.ok(merged);
  const parsed = JSON.parse(merged) as { mcpServers: Record<string, unknown> };
  assert.equal(parsed.mcpServers['jcode-tools'], undefined);
  assert.deepEqual(parsed.mcpServers['scode-tools'], { command: 'node', args: ['/new/server.js'] });
  assert.deepEqual(parsed.mcpServers.other, { command: 'x' });
});

test('mergeCodexToml: drops a legacy jcode-tools section', () => {
  const existing = [
    '# jcode-tools MCP server (managed by `scode tools install`)',
    '[mcp_servers.jcode-tools]',
    'command = "node"',
    'args = ["/old/server.js"]',
    '',
    '[other]',
    'x = 1',
    '',
  ].join('\n');
  const merged = mergeCodexToml(existing, 'node', ['/new/server.js']);
  assert.ok(!merged.includes('jcode-tools'));
  assert.ok(merged.includes('[mcp_servers.scode-tools]'));
  assert.ok(merged.includes('[other]'));
});
