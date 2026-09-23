/** 本地后端 API 客户端。所有请求都打到 127.0.0.1 上的 tools/server.py，不出本机。 */

async function call(method, path, body, headers) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: {
        ...(body === undefined ? undefined : { "Content-Type": "application/json" }),
        ...(headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError("backend_unreachable",
      "连不上本地后端（tools/server.py）。请通过 start.bat 启动，不要直接打开 index.html。");
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* 非 JSON */ }
  if (!payload) throw new ApiError("bad_response", `HTTP ${res.status} ${path}`);
  if (!payload.ok) {
    const err = payload.error || {};
    throw new ApiError(err.code || "error", err.message || "未知错误");
  }
  return payload.data;
}

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 删除操作的密码通过自定义 header 传递，不进 URL、不进 localStorage */
const delHeaders = (password) =>
  password ? { "X-Delete-Password": password } : {};

export const api = {
  issues: (p, m, v) => call('GET', `/versions/${p}/${m}/${v}/issues`),
  createIssue: (p, m, v, body) => call('POST', `/versions/${p}/${m}/${v}/issues`, body),
  updateIssue: (p, m, v, id, body) => call('PATCH', `/versions/${p}/${m}/${v}/issues/${id}`, body),
  health: () => call("GET", "/health"),
  // ---- 访问权限 ----
  accessStatus: () => call("GET", "/access/status"),
  accessLogin: (code) => call("POST", "/access/login", { code }),
  accessLogout: () => call("POST", "/access/logout", {}),
  internalCode: () => call("GET", "/access/internal-code"),
  projectAccessCode: (pid) => call("GET", `/projects/${pid}/access-code`),
  setProjectAccess: (pid, action) => call("POST", `/projects/${pid}/access-code`, { action }),
  // ---- 资产管理 ----
  projects: () => call("GET", "/projects"),
  project: (pid) => call("GET", `/projects/${pid}`),
  createProject: (name, id, description = "") =>
    call("POST", "/projects", { name, id, description }),
  updateProject: (pid, patch) => call("PATCH", `/projects/${pid}`, patch),
  deleteProject: (pid, password) =>
    call("DELETE", `/projects/${pid}`, undefined, delHeaders(password)),
  createModel: (pid, name, id, description = "") =>
    call("POST", `/projects/${pid}/models`, { name, id, description }),
  updateModel: (pid, mid, patch) => call("PATCH", `/models/${pid}/${mid}`, patch),
  deleteModel: (pid, mid, password) =>
    call("DELETE", `/models/${pid}/${mid}`, undefined, delHeaders(password)),
  version: (pid, mid, vid) => call("GET", `/versions/${pid}/${mid}/${vid}`),
  updateVersion: (pid, mid, vid, patch) =>
    call("PATCH", `/versions/${pid}/${mid}/${vid}`, patch),
  deleteVersion: (pid, mid, vid, password) =>
    call("DELETE", `/versions/${pid}/${mid}/${vid}`, undefined, delHeaders(password)),
  versionLog: (pid, mid, vid) => call("GET", `/versions/${pid}/${mid}/${vid}/log`),
  suggestId: (kind, name) =>
    call("GET", `/suggest-id?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`),
  importCreate: (payload) => call("POST", "/import/jobs", payload),
  importRetry: (projectId, modelId, versionId) =>
    call("POST", "/import/retry", { projectId, modelId, versionId }),
  importStart: (jobId) => call("POST", `/import/jobs/${jobId}/start`),
  importState: (jobId) => call("GET", `/import/jobs/${jobId}`),
  importLog: (jobId) => call("GET", `/import/jobs/${jobId}/log`),
  importCleanup: (jobId) => call("DELETE", `/import/jobs/${jobId}`),
};

/** 上传源文件：用 XHR 才有真实的字节级上传进度（RVM 4.5 MB / TXT 1.3 MB）。 */
export function uploadSource(jobId, which, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/import/jobs/${jobId}/source/${which}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      let payload = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200 && payload?.ok) resolve(payload.data);
      else reject(new ApiError(payload?.error?.code || "upload_failed",
        payload?.error?.message || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError("upload_failed", "上传失败（网络或后端中断）"));
    xhr.send(file);
  });
}
