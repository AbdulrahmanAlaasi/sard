import type { Group, Meeting, Settings } from '../shared/types';
import { migrateSettings } from '../shared/types';

const DB_NAME = 'scrivano';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meetings')) {
        db.createObjectStore('meetings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
      // v2: local groups (organization + cross-meeting chat/memory).
      if (!db.objectStoreNames.contains('groups')) {
        db.createObjectStore('groups', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listMeetings(): Promise<Meeting[]> {
  const db = await openDb();
  const tx = db.transaction('meetings', 'readonly');
  const store = tx.objectStore('meetings');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as Meeting[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const db = await openDb();
  const tx = db.transaction('meetings', 'readonly');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('meetings').get(id);
    req.onsuccess = () => resolve((req.result as Meeting) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMeeting(meeting: Meeting): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meetings', 'readwrite');
  tx.objectStore('meetings').put(meeting);
  await txDone(tx);
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meetings', 'readwrite');
  tx.objectStore('meetings').delete(id);
  await txDone(tx);
}

export async function listGroups(): Promise<Group[]> {
  const db = await openDb();
  const tx = db.transaction('groups', 'readonly');
  const store = tx.objectStore('groups');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as Group[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGroup(group: Group): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('groups', 'readwrite');
  tx.objectStore('groups').put(group);
  await txDone(tx);
}

export async function deleteGroup(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('groups', 'readwrite');
  tx.objectStore('groups').delete(id);
  await txDone(tx);
}

export async function loadSettings(): Promise<Settings> {
  const db = await openDb();
  const tx = db.transaction('settings', 'readonly');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('settings').get('settings');
    req.onsuccess = () => resolve(migrateSettings((req.result as Partial<Settings>) ?? {}));
    req.onerror = () => reject(req.error);
  });
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(settings, 'settings');
  await txDone(tx);
}
