import React from 'react';
import { Box, Text } from 'ink';
import { renderLimits } from '../core/limits.js';
import type { BackendSnapshot } from '../core/types.js';
import type { TuiTheme } from './theme.js';

/**
 * Usage limits view — the same lines `scode usage` prints, rendered in the
 * TUI. One row per usage window with % left, a remaining bar with a pace
 * tick, and a reset countdown.
 */
export function LimitsView({ snapshots, now, theme }: { snapshots: BackendSnapshot[]; now: number; theme?: TuiTheme }) {
  const lines = renderLimits(snapshots, new Date(now));
  return (
    <Box borderStyle="round" borderColor={theme?.border} flexDirection="column" paddingX={1}>
      <Text bold color={theme?.primary ?? 'cyan'}>Usage limits</Text>
      {lines.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index}>{line === '' ? ' ' : line}</Text>
      ))}
      <Text dimColor>Press any key to go back.</Text>
    </Box>
  );
}
