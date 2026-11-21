import type { Server } from 'node:http';

// The runner must await this actual native process. Signals are not success.
export function installIdleShutdown(server: Server, control: { begin: () => boolean; idle: () => boolean }) {
  let closing = false;
  const stop = () => {
    if (closing) return;
    if (!control.begin()) {
      console.warn('Toonflow 尚有请求、作业或未知素材租约，未执行空闲停止');
      return;
    }
    closing = true;
    // begin synchronously closes admission. Do not destroy active sockets or workers.
    server.close(error => {
      if (error || !control.idle()) {
        console.error('Toonflow 未确认空闲关闭，不能作为正常退出', error?.message || '素材/作业状态已变化');
        process.exit(1);
      }
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
