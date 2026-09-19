/* Bundled by scripts/ui-test.mjs — exposes the real app + stores to jsdom. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../client/src/App.jsx';
import { useAuth } from '../client/src/store/auth.js';
import { useDrive } from '../client/src/store/drive.js';
import { useUi } from '../client/src/store/ui.js';
import { useUploads } from '../client/src/store/uploads.js';
import { useJobs } from '../client/src/store/jobs.js';
import * as api from '../client/src/lib/api.js';

window.__tgc = { React, createRoot, App, useAuth, useDrive, useUi, useUploads, useJobs, api };
