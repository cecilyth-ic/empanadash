import { ipcMain } from 'electron';
import { dirname } from 'path';
import * as fs from 'fs';

export function registerDebugIpc() {
  ipcMain.handle(
    'debug:append-log',
    async (_, filePath: string, content: string, options: { reset?: boolean } = {}) => {
      try {
        if (!filePath) throw new Error('filePath is required');

        const dir = dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });

        const flag = options.reset ? 'w' : 'a';
        await fs.promises.writeFile(filePath, content, { flag, encoding: 'utf8' });
        return { success: true };
      } catch (error) {
        console.error('Failed to append debug log:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  );
}
