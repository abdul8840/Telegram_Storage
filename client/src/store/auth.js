/** Authentication store: session bootstrap, login, signup, profile updates. */
import { create } from 'zustand';
import { Auth, getToken, setToken } from '../lib/api.js';

export const useAuth = create((set, get) => ({
  user: null,
  status: 'loading', // loading | authed | anon
  error: null,

  async bootstrap() {
    if (!getToken()) {
      set({ status: 'anon', user: null });
      return null;
    }
    try {
      const { user } = await Auth.me();
      set({ user, status: 'authed', error: null });
      return user;
    } catch (err) {
      setToken(null);
      set({ user: null, status: 'anon', error: err.message });
      return null;
    }
  },

  async login(email, password) {
    set({ error: null });
    try {
      const { token, user } = await Auth.login({ email, password });
      setToken(token);
      set({ user, status: 'authed' });
      return user;
    } catch (err) {
      set({ error: err.message });
      throw err;
    }
  },

  async signup(name, email, password) {
    set({ error: null });
    try {
      const { token, user } = await Auth.signup({ name, email, password });
      setToken(token);
      set({ user, status: 'authed' });
      return user;
    } catch (err) {
      set({ error: err.message });
      throw err;
    }
  },

  async logout() {
    try {
      await Auth.logout();
    } catch {
      /* ignore */
    }
    setToken(null);
    set({ user: null, status: 'anon' });
  },

  async updateProfile(patch) {
    const { user } = await Auth.update(patch);
    set({ user });
    return user;
  },

  async changePassword(currentPassword, newPassword) {
    await Auth.changePassword({ currentPassword, newPassword });
    return true;
  },

  async deleteAccount() {
    await Auth.deleteAccount();
    setToken(null);
    set({ user: null, status: 'anon' });
  },

  /** Local-only settings mirror (avoid a round trip for every toggle). */
  setUser(user) {
    set({ user });
  },
  settings() {
    return get().user?.settings || {};
  },
}));

export default useAuth;
