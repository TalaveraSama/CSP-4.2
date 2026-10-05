import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  AccountError,
  findAccount,
  findIniAccount,
  listAccounts,
  listIniAccounts,
  removeAccount,
  removeIniAccount,
  upsertAccount,
  upsertIniAccount,
  type Account,
} from './accounts.js';
import type { BackendAuth, ProxyBackend } from './backend.js';

/**
 * Where the client accounts of a backend live, and how to change them.
 *
 * Three cases, because the stack has three:
 *  - CSP with SimpleUserManager: <user> elements inside proxy.xml, changed
 *    with fetch-cfg / cfgHandler (the proxy reloads its whole config).
 *  - CSP with XmlUserManager and a local file: the panel writes that file
 *    directly and fires the `update-users` control command. proxy.xml is
 *    never touched, nothing is reloaded — this is the one that scales to
 *    thousands of accounts.
 *  - OSCam/NCam: [account] blocks in ncam.user, through the webif file API.
 *
 * It lives apart from the routes because the expiry sweeper needs it too.
 */
export interface AccountStore {
  kind: 'xml' | 'ini';
  /** Human readable origin, shown in the UI. */
  source: string;
  writable: boolean;
  read(): Promise<string>;
  write(content: string): Promise<void>;
}

const EMPTY_USER_FILE =
  '<?xml version="1.0" encoding="UTF-8"?>\n<xml-user-manager ver="1.0">\n</xml-user-manager>\n';

function localUserFile(xml: string): string | undefined {
    if (!/<user-manager[^>]*XmlUserManager/i.test(xml)) return undefined;
    const url = /<user-file-url>\s*([^<]+?)\s*<\/user-file-url>/i.exec(xml)?.[1];
    if (!url?.startsWith('file:')) return undefined; // http/ftp sources are not ours to edit
  const path = url.slice('file:'.length);
  return path.startsWith('/') ? path : resolve(process.cwd(), path);
}

export async function resolveAccountStore(backend: ProxyBackend, auth: BackendAuth): Promise<AccountStore> {

    if (backend.info.kind === 'csp') {
      const config = await backend.fetchConfig(auth);
      const file = localUserFile(config.content);
      if (file) {
        return {
          kind: 'xml',
          source: file,
          writable: true,
          read: async () => {
            try {
              return await readFile(file, 'utf8');
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return EMPTY_USER_FILE;
              }
              throw new AccountError(`cannot read ${file}: ${(err as Error).message}`, 502);
            }
          },
          write: async (content) => {
            try {
              await writeFile(file, content, { mode: 0o640 });
            } catch (err) {
              throw new AccountError(`cannot write ${file}: ${(err as Error).message}`, 502);
            }
            // Tell the proxy to pick it up now instead of at the next poll.
            await backend.control(auth, 'update-users', {}).catch(() => undefined);
          },
        };
      }
      return {
        kind: 'xml',
        source: config.name,
        writable: config.writable,
        read: async () => config.content,
        write: async (content) => {
          const result = await backend.saveConfig(auth, content);
          if (!result.ok) throw new AccountError(result.message || 'the proxy refused the new config', 400);
        },
      };
    }

    // OSCam and NCam: the accounts file of the running softcam.
    const file = backend.info.configFiles.find((f) => f.endsWith('.user'));
    if (!file) throw new AccountError('this backend has no accounts file', 501);
    const current = await backend.fetchConfig(auth, file);
    return {
      kind: 'ini',
      source: file,
      writable: current.writable,
      read: async () => current.content,
      write: async (content) => {
        const result = await backend.saveConfig(auth, content, file);
        if (!result.ok) throw new AccountError(result.message || `${backend.info.labels.product} refused the file`, 400);
      },
    };
}


/* The panel speaks one account model; each store speaks its own dialect. */
export const readAccounts = (store: AccountStore, text: string): Account[] =>
  store.kind === 'xml' ? listAccounts(text) : listIniAccounts(text);

export const findOne = (store: AccountStore, text: string, name: string): Account | undefined =>
  store.kind === 'xml' ? findAccount(text, name) : findIniAccount(text, name);

export const upsert = (store: AccountStore, text: string, account: Account, create: boolean): string =>
  store.kind === 'xml' ? upsertAccount(text, account, { create }) : upsertIniAccount(text, account, { create });

export const removeFrom = (store: AccountStore, text: string, name: string): string =>
  store.kind === 'xml' ? removeAccount(text, name) : removeIniAccount(text, name);
