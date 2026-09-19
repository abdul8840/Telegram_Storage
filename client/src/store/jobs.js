/** Background job store (transcodes, thumbnail regeneration) fed by SSE. */
import { create } from 'zustand';
import { Jobs } from '../lib/api.js';

export const useJobs = create((set, get) => ({
  jobs: [],
  loaded: false,

  async load() {
    try {
      const { jobs } = await Jobs.list(30);
      set({ jobs: jobs || [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  upsert(job) {
    if (!job) return;
    const id = job._id || job.id || job.jobId;
    set((state) => {
      const index = state.jobs.findIndex((j) => (j._id || j.id) === id);
      if (index >= 0) {
        const next = [...state.jobs];
        next[index] = { ...next[index], ...job };
        return { jobs: next };
      }
      return { jobs: [job, ...state.jobs].slice(0, 40) };
    });
  },

  patch(id, patch) {
    set((state) => ({
      jobs: state.jobs.map((j) => ((j._id || j.id) === id ? { ...j, ...patch } : j)),
    }));
  },

  remove(id) {
    set((state) => ({ jobs: state.jobs.filter((j) => (j._id || j.id) !== id) }));
  },

  active() {
    return get().jobs.filter((j) => ['queued', 'running'].includes(j.status));
  },

  cancel: async (id) => Jobs.cancel(id),
}));

export default useJobs;
