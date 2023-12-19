import Path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Gives a read-only wrapper for an object. All possible methods for writing are blocked.
 * @param data
 * @returns
 */
export function makeReadonly<T>(data: T): Readonly<T> {
  if (data === null) {
    return data;
  }
  if (typeof data === "object") {
    return new Proxy(data, {
      get(target, prop) {
        return makeReadonly((target as Record<string | symbol, unknown>)[prop]);
      },
      set() {
        return true;
      },
      deleteProperty() {
        return true;
      },
    }) as Readonly<T>;
  } else if (typeof data === "function") {
    return (() => {}) as unknown as Readonly<T>;
  } else {
    return data;
  }
}

/**
 * Get a copy of an object that can be written as json
 * @param data
 * @returns
 */
export function copyData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

type DBTransaction<T> = [
  () => MaybePromise<T>, // todo
  string, // uuid
  (value: T) => void, // resolve
];

class Transaction {
  list: DBTransaction<unknown>[] = [];
  uuid?: string = undefined;
}

class SillyDBStatus {
  DB: typeof SillyDB;

  TIMEOUT: number = 10000; // 10s

  events = new EventEmitter();
  transactions = {
    unlock: new Transaction(),
    write_end: new Transaction(),
  };

  __db_name: string;
  get db_path() {
    return this.__db_name;
  }
  set db_path(db_name) {
    this.__db_name = db_name;
  }

  __data: unknown;
  get data() {
    return this.__data;
  }
  setdata(data: unknown) {
    this.__data = data;
  }

  /**
   * waiter
   */
  wait<T, K extends keyof SillyDBStatus["transactions"]>(
    event: K,
    uuid: string,
    todo: DBTransaction<T>[0],
  ) {
    return new Promise<T>((resolve) => {
      this.transactions[event].list.push([
        todo,
        uuid,
        resolve as (_?: unknown) => void,
      ]);
      if (!this.transactions[event].uuid) {
        this.events.emit(event);
      }
    });
  }

  constructor(DB: typeof SillyDB) {
    this.DB = DB;
    this.__db_name = DB.UID;

    const event_list: (keyof SillyDBStatus["transactions"])[] = Object.keys(
      this.transactions,
    ) as (keyof SillyDBStatus["transactions"])[];
    event_list.forEach((eventName) => {
      this.events.on(eventName, async () => {
        this.transactions[eventName].uuid = undefined;

        const _tmp = this.transactions[eventName].list.shift();
        if (!_tmp) {
          return;
        }

        const [todo, uuid, resolve] = _tmp;
        this.transactions[eventName].uuid = uuid;

        resolve(await todo());
        this.events.emit(eventName);
      });
    });

    this.__data = SillyDBUtils.safeReadDB(DB);
  }
}

type DBtype<T> = typeof SillyDB | SillyDB<T>;

class SillyDBUtils {
  private static __path: string = "./data";

  private static __databases: Record<string, SillyDBStatus | undefined> = {};

  static hasDB<T>(db: string | DBtype<T>): SillyDBStatus | undefined {
    if (typeof db === "string") {
      return this.__databases[db];
    }
    if (db instanceof SillyDB) {
      return this.hasDB(this.getClass(db));
    }
    if (db === SillyDB || SillyDB.isPrototypeOf(db)) {
      return this.hasDB(db.UID);
    }
    throw TypeError();
  }

  static getDBStatus<T>(db: string | DBtype<T>) {
    const DB = this.hasDB(db);
    if (!DB) {
      throw Error(`Using a DB ${db} that is not registed is not allowed`);
    }
    return DB;
  }

  static async lockDB<T>(db: DBtype<T>, uuid: string) {
    const dbstatus = this.hasDB(db);
    if (!dbstatus) {
      throw Error("locking a db that is not registed");
    }
    let resolver: () => void = () => {};
    let lock: Promise<void>;
    await new Promise<void>((mak) => {
      lock = new Promise<void>((res) => {
        resolver = res;
        mak();
      });
    });
    await new Promise<void>((lockover) => {
      dbstatus.wait("unlock", uuid, () => {
        lockover();
        return lock;
      });
    });
    return resolver;
  }

  static getData<T>(db: DBtype<T>): unknown {
    return this.getDBStatus(db).data;
  }

  static getClass<T>(db: DBtype<T>): typeof SillyDB {
    if (db === SillyDB || SillyDB.isPrototypeOf(db)) {
      return db as typeof SillyDB;
    }
    return db.constructor as typeof SillyDB;
  }

  static regist<T>(db: DBtype<T>) {
    if (this.hasDB(db)) {
      return;
    } // db is registed.

    this.__databases[this.getClass(db).UID] = new SillyDBStatus(
      this.getClass(db),
    );
  }

  static writeDB<T>(db: DBtype<T>) {
    try {
      function writeToPath(dir: string, path: string, data: unknown) {
        const p = Path.join(dir, path);
        try {
          fs.writeFileSync(p, JSON.stringify(data));
        } catch (err) {
          fs.mkdirSync(dir, {
            recursive: true,
          });
          fs.writeFileSync(p, JSON.stringify(data));
        }
      }
      writeToPath(this.getPath(db), "data.swp.json", this.getData(db));
      writeToPath(this.getPath(db), "data.json", this.getData(db));
      return "success";
    } catch (err) {
      console.error(err);
      return "failed";
    }
  }

  static async safeWriteDB<T>(db: DBtype<T>, uuid: string): Promise<string> {
    return await this.getDBStatus(db).wait("write_end", uuid, () => {
      return this.writeDB(db);
    });
  }

  static safeReadDB<T>(db: DBtype<T>) {
    try {
      return JSON.parse(
        fs.readFileSync(Path.join(this.getPath(db), "data.json")).toString(),
      );
    } catch (err) {
      console.error(err);
      try {
        return JSON.parse(
          fs
            .readFileSync(Path.join(this.getPath(db), "data.swp.json"))
            .toString(),
        );
      } catch (err) {
        return undefined;
      }
    }
  }

  static setData<T>(db: DBtype<T>, data: unknown) {
    this.getDBStatus(db).setdata(data);
  }

  static root_path(newPath?: string) {
    if (newPath) {
      this.__path = newPath;
    }
    return this.__path;
  }

  static getPath<T>(db: DBtype<T>) {
    return Path.join(
      this.root_path(),
      ...this.getClass(db).UID.split(".").slice(1),
    );
  }
}

export class SillyDBManager {
  /**
   * Get or set the database root directory
   * @param newPath
   */
  static root_path(newPath?: string) {
    SillyDBUtils.root_path(newPath);
  }
}

export interface SillyDBOptions {
  autoUse?: boolean;
}

/**
 * Database class
 *
 * ## Explanation
 *
 * Each SillyDB class (and its subclasses) uses a {@link SillyDB.UID | UID} to uniquely determine what data it uses.
 *
 * By default, UIDs are automatically generated based on class inheritance. If you need, you can manually assign the UID attribute, which will manually correspond to a database.
 *
 * ```typescript
 * class UserDB extends SillyDB {}
 * ```
 *
 * or
 *
 * ```
 * const UserDB = SillyDB.sub("UserDB");
 * ```
 *
 * ## Usage
 *
 * ```
 * await using db = await SillyDB.use<TYPE>(default_value, options?);
 * ```
 *
 * It will automatically use and save.
 *
 * If you want to lock and unlock the database yourself (this is dangerous, once you forget to unlock it, all subsequent operations will be stuck!), you can:
 *
 * ```
 * const db = new SillyDB<TYPE>(default_value, options?);
 * // now db is readonly
 * await db.use();
 * // db is now locked and ready to write
 *
 * // something like db.data.a = 1
 *
 * await db.saveClose();
 * // now db is readonly
 * ```
 *
 */
export class SillyDB<T> implements AsyncDisposable {
  /**
   * A copy of default value
   */
  private __default: T;
  /**
   * Internal variable that handles whether the database is in a locked state. See `use` for details
   * @see{@link use}
   */
  private __locking = false;
  private __uuid: string;

  private unlockDB: () => void = () => {
    throw "use a DB before unlock.";
  };

  /**
   * The unique identifier of the database. (There should be no collision unless you are the unluckiest human in the world...)
   */
  get uuid() {
    return this.__uuid;
  }

  static get super(): typeof SillyDB {
    const par = Object.getPrototypeOf(this);
    return par;
  }

  /**
   * Describes the unique id of the database corresponding to this class.
   * Concatenated by the UID of its parent class and its own description.
   *
   * The UID uniquely identifies the database. Libraries with the same UID will access the same data.
   *
   * ```typescript
   * class uwu extends SillyDB {}
   * class nya extends uwu {}
   *
   * uwu.UID // "SillyDB.uwu"
   * nya.UID // "SillyDB.uwu.nya"
   *
   * uwu.sub("nya") // Can obtain data equivalent to [class nya extends uwu]
   * ```
   *
   *
   */
  static get UID(): string {
    if (SillyDB.isPrototypeOf(this)) {
      return this.super.UID + "." + this.name;
    }
    return this.name;
  }

  static nametest(name: string) {
    return /^[_a-zA-Z0-9\-]+$/.test(name);
  }

  /**
   * Sometimes you may need to dynamically access subdatabases. This method helps you do that.
   *
   * ```typescript
   * class uwu extends SillyDB {}
   * await using a = (await new uwu(...)).use();
   * ```
   * `a` shares the same data with
   * ```typescript
   * await using b = await SillyDB.sub("uwu").use(...);
   * ```
   * @param subname sub database name
   * @returns
   */
  static sub(subname: string): typeof SillyDB {
    const dot = subname.indexOf(".");
    if (dot !== -1) {
      return this.sub(subname.slice(0, dot)).sub(subname.slice(dot + 1));
    }
    if (!this.nametest(subname)) {
      throw SyntaxError(`Subname ${subname} is invalid.`);
    }
    class SubDB<T> extends this<T> {
      static get UID() {
        return `${this.super.UID}.${subname}`;
      }
    }
    return SubDB;
  }

  /**
   * Syntactic sugar for JavaScript users. After the passed handle function returns, automatically close the database.
   *
   * ```javascript
   * SillyDB.tap({ a: 1, b: 2 }, (db) => {
   *   db.data.a = 114514;
   * });
   * ```
   *
   * equals to
   *
   * ```javascript
   * const db = new SillyDB({ a: 1, b: 2 });
   * await db.use();
   * db.data.a = 114514;
   * await db.saveClose();
   * ```
   *
   * or typescript
   *
   * ```typescript
   * await using db = await SillyDB.use({ a: 1, b: 2 });
   * db.data.a = 114514
   * ```
   *
   * We recommend TypeScript users to use the last option.
   * @param dv
   * @param handle
   * @param options
   */
  static async tap<T>(
    dv: T,
    handle: (arg0: SillyDB<T>) => MaybePromise<void>,
    options?: SillyDBOptions,
  ) {
    await using db = await new this<T>(dv, options).use();
    await handle(db);
  }

  /**
   * equals to `(new SillyDB(...)).use()`
   * @returns
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static use<T>(defaultValue: T, options?: SillyDBOptions) {
    return new this<T>(defaultValue, options).use();
  }

  constructor(defaultValue: T, options?: SillyDBOptions) {
    options = options ?? {};
    options.autoUse = options.autoUse ?? true;

    SillyDBUtils.regist(this);
    this.__default = copyData(defaultValue);
    this.__uuid = crypto.randomUUID();
  }

  /**
   * Necessary actions before writing to the database. If you don't perform `use` before getting `data`, then `data` will throw a error.
   * @returns this
   */
  async use() {
    if (this.__locking) {
      return this;
    }
    this.unlockDB = await SillyDBUtils.lockDB(this, this.__uuid);
    this.__locking = true;
    return this;
  }

  /**
   * close database
   * @returns this
   */
  close() {
    this.unlockDB();
    this.__locking = false;
    return this;
  }

  async save(): Promise<string> {
    if (!this.__locking) {
      throw Error("Cannot save before use!");
    }
    return await SillyDBUtils.safeWriteDB(this, this.uuid);
  }

  async saveClose() {
    if (!this.__locking) {
      throw Error("Cannot save before use!");
    }
    await this.save();
    this.close();
    return;
  }

  /**
   * Return the data wrapped in {@link makeReadonly | `makeReadonly`}, and you cannot perform any write operations on it.
   */
  get dataReadonly() {
    const __data: unknown = SillyDBUtils.getData(this);
    if (!__data) {
      return makeReadonly(this.__default);
    }
    return makeReadonly(__data as T);
  }

  /**
   * Get a copy of data.
   */
  datacopy() {
    const __data: unknown = SillyDBUtils.getData(this);
    if (!__data) {
      return copyData(this.__default);
    }
    return copyData(__data as T);
  }

  /**
   * Get the data. **WILL throw a error unless you perform {@link use | `use`} before**
   */
  get data(): T {
    if (!this.__locking) {
      throw Error(
        "You can't get data before `use`. If you don't intend to write, use dataReadonly or dataCopy() instead",
      );
    }
    const __data: unknown = SillyDBUtils.getData(this);
    if (!__data) {
      SillyDBUtils.setData(this, this.__default);
      return this.__default;
    }
    return __data as T;
  }
  set data(newData) {
    if (!this.__locking) {
      throw Error("Cannot set data before use!");
    }
    SillyDBUtils.setData(this, newData);
  }

  async [Symbol.asyncDispose]() {
    if (this.__locking) {
      await this.saveClose();
    }
  }
}

export default SillyDB;
