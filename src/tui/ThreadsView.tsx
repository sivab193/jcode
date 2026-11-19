import React from 'react';
import { Box, Text } from 'ink';
import { renderThreadList, type Thread } from '../core/threads.js';
import type { TuiTheme } from './theme.js';

/** Full-screen threads list (the `G` key). Same shape as the limits view. */
export function ThreadsView({ threads, theme }: { threads: Thread[]; theme?: TuiTheme }): React.ReactElement {
  const lines = renderThreadList(threads);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme?.border} paddingX={1}>
      <Text bold color={theme?.primary ?? 'cyan'}>Threads</Text>
      {lines.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index}>{line === '' ? ' ' : line}</Text>
      ))}
      <Text dimColor>Press any key to go back.</Text>
    </Box>
  );
}
