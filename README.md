JSON-based database class with built-in lock.

## Tutorial

```typescript
import SillyDB, { SillyDBManager } from "silly-db";

// SillyDBManager.root_path("./mydatabase"); // Modify the database root directory. Default is ./data

type User = {
  uid: number;
  username: string;
};

async function addUserAndQuit(uid: number) {
  await using db = await SillyDB.sub("UserDB").use<User[]>([]);
  const data = db.data;
  data.push({
    uid,
    username: `Test_User_${uid}`,
  });
}

addUserAndQuit(1);
addUserAndQuit(2);
addUserAndQuit(3);
addUserAndQuit(4);
addUserAndQuit(5);

// data/UserDB/data.json
// [{"uid":1,"username":"Test_User_1"},{"uid":2,"username":"Test_User_2"},{"uid":3,"username":"Test_User_3"},{"uid":4,"username":"Test_User_4"},{"uid":5,"username":"Test_User_5"}]
```
