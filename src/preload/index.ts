import { contextBridge } from 'electron';

// M0 minimal preload stub; full allowlisted API is established in M3
contextBridge.exposeInMainWorld('aeroPlatform', Object.freeze({}));
