import {
  FeishuStatusResponse,
  FeishuAuthStartResponse,
  FeishuAuthPollResponse,
  FeishuExecResponse,
  FeishuRosterStatusResponse,
} from '../types/feishu';

class FeishuService {
  async getRosterStatus(): Promise<FeishuRosterStatusResponse> {
    const res = await fetch('/api/feishu/roster-status', {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new Error((await res.json()).detail || '获取全员飞书授权状态失败');
    }
    return res.json();
  }

  async getStatus(): Promise<FeishuStatusResponse> {
    const res = await fetch('/api/feishu/status', {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new Error((await res.json()).detail || '获取飞书 CLI 状态失败');
    }
    return res.json();
  }

  async startAuth(): Promise<FeishuAuthStartResponse> {
    const res = await fetch('/api/feishu/auth/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error((await res.json()).detail || '发起飞书授权失败');
    }
    return res.json();
  }

  async pollAuth(): Promise<FeishuAuthPollResponse> {
    const res = await fetch('/api/feishu/auth/poll', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error((await res.json()).detail || '检查授权结果失败');
    }
    return res.json();
  }

  async logout(): Promise<{ success: boolean; message: string }> {
    const res = await fetch('/api/feishu/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error((await res.json()).detail || '退出飞书授权失败');
    }
    return res.json();
  }

  async execAction(action: string): Promise<FeishuExecResponse> {
    const res = await fetch('/api/feishu/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      throw new Error((await res.json()).detail || '执行飞书指令失败');
    }
    return res.json();
  }
}

export const feishuService = new FeishuService();
