/**
 * API client.
 *
 * The token is sent as a Bearer header for XHR and also lives in an httpOnly
 * cookie (set by the server at login) so that <video>, <img> and download
 * links — which cannot carry headers — are authorised too.
 */
import axios from 'axios';

export const TOKEN_KEY = 'tgc_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 0, // uploads and Telegram calls can legitimately take minutes
});

api.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

/** Unwraps axios errors into `{ message, status, code, details }`. */
export function normalizeError(err) {
  const data = err?.response?.data;
  return {
    message: data?.error || err?.message || 'Request failed',
    status: err?.response?.status || 0,
    code: data?.code || null,
    details: data?.details || null,
    isCancel: axios.isCancel(err),
    raw: err,
  };
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const normalized = normalizeError(err);
    // Session expired → bounce to the sign-in page (but never during sign-in).
    if (normalized.status === 401 && getToken() && !window.location.pathname.startsWith('/login')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      setToken(null);
      window.location.href = `/login?next=${next}&expired=1`;
    }
    return Promise.reject(normalized);
  },
);

const unwrap = (promise) => promise.then((r) => r.data);

export const Auth = {
  signup: (body) => unwrap(api.post('/auth/signup', body)),
  login: (body) => unwrap(api.post('/auth/login', body)),
  logout: () => unwrap(api.post('/auth/logout')),
  me: () => unwrap(api.get('/auth/me')),
  update: (body) => unwrap(api.patch('/auth/me', body)),
  changePassword: (body) => unwrap(api.post('/auth/change-password', body)),
  deleteAccount: () => unwrap(api.delete('/auth/me')),
};

export const Files = {
  list: (params) => unwrap(api.get('/files', { params })),
  get: (id) => unwrap(api.get(`/files/${id}`)),
  patch: (id, body) => unwrap(api.patch(`/files/${id}`, body)),
  rename: (id, name) => unwrap(api.patch(`/files/${id}`, { name })),
  move: (fileIds, folderId) => unwrap(api.post('/files/move', { fileIds, folderId })),
  star: (fileIds, starred) => unwrap(api.post('/files/star', { fileIds, starred })),
  trash: (fileIds, folderIds = []) => unwrap(api.post('/files/trash', { fileIds, folderIds })),
  restore: (fileIds, folderIds = []) => unwrap(api.post('/files/restore', { fileIds, folderIds })),
  remove: (fileIds) => unwrap(api.delete('/files', { data: { fileIds } })),
  emptyTrash: () => unwrap(api.post('/files/trash/empty')),
  stats: () => unwrap(api.get('/files/stats')),
  text: (id) => unwrap(api.get(`/files/${id}/text`)),
  transcode: (id, maxDimension) => unwrap(api.post(`/files/${id}/transcode`, { maxDimension })),
  regenerate: (id) => unwrap(api.post(`/files/${id}/regenerate`)),
  retry: (id) => unwrap(api.post(`/files/${id}/retry`)),
  cancel: (id) => unwrap(api.post(`/files/${id}/cancel`)),
};

export const Folders = {
  tree: () => unwrap(api.get('/folders')),
  create: (name, parentId = null) => unwrap(api.post('/folders', { name, parentId })),
  rename: (id, name) => unwrap(api.patch(`/folders/${id}`, { name })),
  move: (id, parentId) => unwrap(api.patch(`/folders/${id}`, { parentId })),
  remove: (id, mode = 'trash') => unwrap(api.delete(`/folders/${id}`, { params: { mode } })),
  ensurePath: (folderPath) => unwrap(api.post('/folders/ensure-path', { path: folderPath })),
};

export const Uploads = {
  create: (body) => unwrap(api.post('/uploads', body)),
  state: (id) => unwrap(api.get(`/uploads/${id}`)),
  /** Sends one raw chunk. `onProgress` receives 0..100 for this chunk. */
  chunk: (id, index, blob, { onProgress, signal } = {}) =>
    unwrap(
      api.put(`/uploads/${id}/chunks/${index}`, blob, {
        headers: { 'Content-Type': 'application/octet-stream' },
        onUploadProgress: (e) => {
          if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
        },
        signal,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }),
    ),
  complete: (id) => unwrap(api.post(`/uploads/${id}/complete`)),
  cancel: (id) => unwrap(api.post(`/uploads/${id}/cancel`)),
  remove: (id) => unwrap(api.delete(`/uploads/${id}`)),
};

export const Telegram = {
  status: () => unwrap(api.get('/telegram/status')),
  start: (body) => unwrap(api.post('/telegram/login/start', body)),
  code: (code) => unwrap(api.post('/telegram/login/code', { code })),
  password: (password) => unwrap(api.post('/telegram/login/password', { password })),
  resend: (forceSMS) => unwrap(api.post('/telegram/login/resend', { forceSMS })),
  cancelLogin: () => unwrap(api.post('/telegram/login/cancel')),
  verify: () => unwrap(api.post('/telegram/verify')),
  disconnect: () => unwrap(api.post('/telegram/disconnect')),
  setChatTarget: (target) => unwrap(api.patch('/telegram/chat-target', { target })),
  chats: () => unwrap(api.get('/telegram/chats')),
  remote: (params) => unwrap(api.get('/telegram/remote', { params })),
  importItems: (body) => unwrap(api.post('/telegram/import', body)),
};

export const Shares = {
  list: (fileId) => unwrap(api.get('/shares', { params: fileId ? { fileId } : {} })),
  create: (body) => unwrap(api.post('/shares', body)),
  update: (token, body) => unwrap(api.patch(`/shares/${token}`, body)),
  revoke: (token) => unwrap(api.delete(`/shares/${token}`)),
};

export const Jobs = {
  list: (limit = 25) => unwrap(api.get('/jobs', { params: { limit } })),
  get: (id) => unwrap(api.get(`/jobs/${id}`)),
  cancel: (id) => unwrap(api.post(`/jobs/${id}/cancel`)),
};

export const Meta = {
  config: () => unwrap(api.get('/meta/config')),
  capabilities: () => unwrap(api.get('/meta/capabilities')),
  summary: () => unwrap(api.get('/meta/summary')),
  health: () => fetch('/healthz').then((r) => r.json()),
};

export const PublicApi = {
  get: (token, password) =>
    axios
      .get(`/api/public/${token}`, { params: password ? { password } : {}, withCredentials: true })
      .then((r) => r.data)
      .catch((e) => Promise.reject(normalizeError(e))),
  unlock: (token, password) =>
    axios
      .post(`/api/public/${token}/unlock`, { password }, { withCredentials: true })
      .then((r) => r.data)
      .catch((e) => Promise.reject(normalizeError(e))),
};

/** Media URLs. `token` is appended for SSE / contexts without cookies. */
export const urls = {
  stream: (id, token) => `/api/files/${id}/stream${token ? `?access_token=${encodeURIComponent(token)}` : ''}`,
  download: (id, token) => `/api/files/${id}/download${token ? `?access_token=${encodeURIComponent(token)}` : ''}`,
  thumbnail: (id, token) => `/api/files/${id}/thumbnail${token ? `?access_token=${encodeURIComponent(token)}` : ''}`,
  preview: (id, token) => `/api/files/${id}/preview${token ? `?access_token=${encodeURIComponent(token)}` : ''}`,
  events: (token) => `/api/events?access_token=${encodeURIComponent(token)}`,
  publicStream: (shareToken) => `/api/public/${shareToken}/stream`,
  publicDownload: (shareToken) => `/api/public/${shareToken}/download`,
  publicThumbnail: (shareToken) => `/api/public/${shareToken}/thumbnail`,
  publicPreview: (shareToken) => `/api/public/${shareToken}/preview`,
};

/** Starts a browser download through the authenticated endpoint. */
export function downloadFile(id, name) {
  const token = getToken();
  const a = document.createElement('a');
  a.href = urls.download(id, token);
  a.download = name || '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function absoluteUrl(pathOrUrl) {
  if (!pathOrUrl) return '';
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${window.location.origin}${pathOrUrl}`;
}

export default api;
