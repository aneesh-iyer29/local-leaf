// Persistent settings live in ~/.local-leaf/config.json so projects stay untouched.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.local-leaf');
const file = join(dir, 'config.json');

const defaults = { recent: [], projects: {} };
let cfg = load();

function load() {
  try {
    return { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

function save() {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}

export function recentProjects() {
  return cfg.recent;
}

export function touchRecent(path) {
  cfg.recent = [{ path, lastOpened: Date.now() }, ...cfg.recent.filter((r) => r.path !== path)].slice(0, 20);
  save();
}

export function forgetRecent(path) {
  cfg.recent = cfg.recent.filter((r) => r.path !== path);
  save();
}

export function getGlobal(key, fallback) {
  return cfg.global?.[key] ?? fallback;
}
export function setGlobal(key, value) {
  cfg.global = { ...(cfg.global || {}), [key]: value };
  save();
}

export function projectSettings(path) {
  return { main: null, engine: 'pdflatex', autoCompile: true, ...(cfg.projects[path] || {}) };
}

export function updateProjectSettings(path, patch) {
  cfg.projects[path] = { ...projectSettings(path), ...patch };
  save();
  return cfg.projects[path];
}
