/** Uses Coo's own provider transactions; credentials stay inside the Coo host. */
export class ModelControl {
  constructor(context) { this.context = context; }
  async request(path, body, timeout = 20000) {
    const port = this.context.cfg.consolePort ?? 17788;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Coo 控制台端口无效');
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `Coo 返回 ${response.status}`);
    return value;
  }
  async state(selected) {
    const list = await this.request('/api/providers');
    const id = selected ?? list.active;
    if (!list.providers.some(p => p.name === id)) throw new Error('模型连接不存在');
    const detail = await this.request(`/api/providers/${encodeURIComponent(id)}`);
    const models = [];
    const modelError = '模型目录和可用思考档位未由公开接口提供，请手动填写模型 ID；其他档位请在电脑 Coo 中设置。';
    const spec = detail.entry.spec ?? {};
    const effort = spec.thinking === false ? 'none' : spec.reasoningEffort ?? 'default';
    const deepseek = (() => { try { return new URL(detail.entry.baseUrl).hostname === 'api.deepseek.com'; } catch { return false; } })();
    // The public provider endpoint does not expose a supported tier catalog.
    const tiers = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    return {
      active_provider: list.active, selected_provider: id,
      providers: list.providers.map(p => ({ id: p.name, model: p.model, ready: p.readiness?.state === 'ready', active: p.active })),
      model: spec.model ?? '', effort, revision: detail.revision, multimodal: detail.entry.multimodal === true && !(deepseek && spec.model === 'deepseek-v4-pro'),
      models: models.map(m => ({ id: m.id, name: m.displayName ?? m.id })).filter(m => typeof m.id === 'string'),
      efforts: [...new Set([...tiers, effort])], model_error: modelError,
    };
  }
  async brief(request = path => this.request(path), directory) {
    const list = directory ?? await request('/api/providers');
    if (!list.active) return { active_provider: null, model: null, effort: null };
    const detail = await request(`/api/providers/${encodeURIComponent(list.active)}`);
    const spec = detail.entry.spec ?? {};
    const deepseek = (() => { try { return new URL(detail.entry.baseUrl).hostname === 'api.deepseek.com'; } catch { return false; } })();
    return { active_provider: list.active, model: spec.model ?? '', effort: spec.thinking === false ? 'none' : spec.reasoningEffort ?? 'default', revision: detail.revision,
      model_accepts_image: detail.entry.multimodal === true && !(deepseek && spec.model === 'deepseek-v4-pro') };
  }
  async apply(input) {
    if (!input || typeof input.provider !== 'string' || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 ||
        !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.effort) || typeof input.revision !== 'string') throw new Error('模型设置不完整');
    const list = await this.request('/api/providers');
    if (!list.providers.some(p => p.name === input.provider && p.readiness?.state === 'ready')) throw new Error('该模型连接尚未配置完成');
    const path = `/api/providers/${encodeURIComponent(input.provider)}`;
    const detail = await this.request(path);
    if (detail.revision !== input.revision) throw new Error('Coo 设置已在别处改变，请刷新后重试');
    const entry = detail.entry;
    entry.spec = { ...entry.spec, model: input.model, thinking: input.effort !== 'none' };
    if (input.effort === 'none' || input.effort === 'default') delete entry.spec.reasoningEffort;
    else entry.spec.reasoningEffort = input.effort;
    // DeepSeek's public model list distinguishes the vision Flash and text-only Pro.
    const deepseek = (() => { try { return new URL(entry.baseUrl).hostname === 'api.deepseek.com'; } catch { return false; } })();
    if (deepseek) {
      if (input.model === 'deepseek-flash') entry.multimodal = true;
      if (input.model === 'deepseek-v4-pro') entry.multimodal = false;
    }
    await this.request(`${path}/save`, { name: input.provider, entry, expectedRevision: input.revision });
    if (list.active !== input.provider) {
      try { await this.request(`${path}/activate`, {}); }
      catch (error) { throw new Error(`连接已保存，但未能切换：${String(error?.message ?? error)}`); }
    }
    return this.state(input.provider);
  }
}
