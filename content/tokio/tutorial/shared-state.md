---
title: "共享状态 (Shared state)"
---

到目前为止，我们已经有了一个可以工作的键值服务器。然而，它有一个重大缺陷：
状态没有在连接之间共享。我们将在本章中解决这个问题。

# 策略 (Strategies)

在 Tokio 中，有几种不同的方法可以共享状态。

1. 使用 `Mutex` 保护共享状态。
2. 生成一个任务来管理状态，并使用消息传递来操作它。

通常，对于简单数据，你希望使用第一种方法；对于需要异步工作的东西（例如 I/O 原语），则使用第二种方法。在本章中，共享状态是一个 `HashMap`，操作是 `insert` 和 `get`。这两个操作都不是异步的，因此我们将使用 `Mutex`。

后一种方法将在下一章中介绍。

# 添加 `bytes` 依赖 (Add `bytes` dependency)

Mini-Redis crate 使用 [`bytes`] crate 中的 `Bytes`，而不是 `Vec<u8>`。`Bytes` 的目标是为网络编程提供一个健壮的字节数组结构。它比 `Vec<u8>` 最大的特性是浅拷贝 (shallow cloning)。换句话说，在 `Bytes` 实例上调用 `clone()` 不会复制底层数据。相反，`Bytes` 实例是对某些底层数据的引用计数句柄。`Bytes` 类型大致相当于 `Arc<Vec<u8>>`，但具有一些附加功能。

要依赖 `bytes`，请将以下内容添加到你的 `Cargo.toml` 的 `[dependencies]` 部分：

```toml
bytes = "1"
```

[`bytes`]: https://docs.rs/bytes/1/bytes/struct.Bytes.html

# 初始化 `HashMap` (Initialize the `HashMap`)

`HashMap` 将在许多任务中共享，并可能在许多线程中共享。为了支持这一点，它被包装在 `Arc<Mutex<_>>` 中。

首先，为方便起见，在 `use` 语句之后添加以下类型别名。

```rust
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<HashMap<String, Bytes>>>;
```

然后，更新 `main` 函数以初始化 `HashMap`，并将一个 `Arc` **句柄 (handle)** 传递给 `process` 函数。使用 `Arc` 允许 `HashMap` 被许多任务并发引用，这些任务可能在许多线程上运行。在整个 Tokio 中，术语**句柄 (handle)** 用于引用提供对某些共享状态访问的值。

```rust
use tokio::net::TcpListener;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

# fn dox() {
#[tokio::main]
async fn main() {
    let listener = TcpListener::bind("127.0.0.1:6379").await.unwrap();

    println!("Listening");

    let db = Arc::new(Mutex::new(HashMap::new()));

    loop {
        let (socket, _) = listener.accept().await.unwrap();
        // 克隆哈希映射的句柄。
        let db = db.clone();

        println!("Accepted");
        tokio::spawn(async move {
            process(socket, db).await;
        });
    }
}
# }
# type Db = Arc<Mutex<HashMap<(), ()>>>;
# async fn process(_: tokio::net::TcpStream, _: Db) {}
```

## 关于使用 `std::sync::Mutex` 和 `tokio::sync::Mutex` (On using `std::sync::Mutex` and `tokio::sync::Mutex`)

请注意，这里使用 `std::sync::Mutex` 而**不是** `tokio::sync::Mutex` 来保护 `HashMap`。一个常见的错误是在异步代码中无条件地使用 `tokio::sync::Mutex`。异步互斥锁 (async mutex) 是一个在调用 `.await` 期间保持锁定状态的互斥锁。

同步互斥锁在等待获取锁时会阻塞当前线程。这反过来又会阻止其他任务的处理。然而，切换到 `tokio::sync::Mutex` 通常没有帮助，因为异步互斥锁在内部使用同步互斥锁。

根据经验，只要争用 (contention) 保持较低水平并且锁没有在调用 `.await` 期间保持，在异步代码中使用同步互斥锁是可以的。

# 更新 `process()` (Update `process()`)

process 函数不再初始化 `HashMap`。相反，它接收一个指向 `HashMap` 的共享句柄作为参数。在使用之前，它还需要锁定 `HashMap`。请记住，`HashMap` 的值类型现在是 `Bytes`（我们可以廉价地克隆它），因此这也需要更改。

```rust
use tokio::net::TcpStream;
use mini_redis::{Connection, Frame};
# use std::collections::HashMap;
# use std::sync::{Arc, Mutex};
# type Db = Arc<Mutex<HashMap<String, bytes::Bytes>>>;

async fn process(socket: TcpStream, db: Db) {
    use mini_redis::Command::{self, Get, Set};

    // `Connection` 由 `mini-redis` 提供，处理从套接字解析帧
    let mut connection = Connection::new(socket);

    while let Some(frame) = connection.read_frame().await.unwrap() {
        let response = match Command::from_frame(frame).unwrap() {
            Set(cmd) => {
                let mut db = db.lock().unwrap();
                db.insert(cmd.key().to_string(), cmd.value().clone());
                Frame::Simple("OK".to_string())
            }
            Get(cmd) => {
                let db = db.lock().unwrap();
                if let Some(value) = db.get(cmd.key()) {
                    Frame::Bulk(value.clone())
                } else {
                    Frame::Null
                }
            }
            cmd => panic!("unimplemented {:?}", cmd),
        };

        // 将响应写入客户端
        connection.write_frame(&response).await.unwrap();
    }
}
```

# 在 `.await` 期间持有 `MutexGuard` (Holding a `MutexGuard` across an `.await`)

你可能会编写如下代码：

```rust
use std::sync::{Mutex, MutexGuard};

async fn increment_and_do_stuff(mutex: &Mutex<i32>) {
    let mut lock: MutexGuard<i32> = mutex.lock().unwrap();
    *lock += 1;

    do_something_async().await;
} // lock 在此处离开作用域
# async fn do_something_async() {}
```

当你尝试生成 (spawn) 调用此函数的任务时，会遇到以下错误消息：

```text
error: future cannot be sent between threads safely
   --> src/lib.rs:13:5
    |
13  |     tokio::spawn(async move {
    |     ^^^^^^^^^^^^ future created by async block is not `Send`
    |
   ::: /playground/.cargo/registry/src/github.com-1ecc6299db9ec823/tokio-0.2.21/src/task/spawn.rs:127:21
    |
127 |         T: Future + Send + 'static,
    |                     ---- required by this bound in `tokio::task::spawn::spawn`
    |
    = help: within `impl std::future::Future`, the trait `std::marker::Send` is not implemented for `std::sync::MutexGuard<'_, i32>`
note: future is not `Send` as this value is used across an await
   --> src/lib.rs:7:5
    |
4   |     let mut lock: MutexGuard<i32> = mutex.lock().unwrap();
    |         -------- has type `std::sync::MutexGuard<'_, i32>` which is not `Send`
...
7   |     do_something_async().await;
    |     ^^^^^^^^^^^^^^^^^^^^^^^^^^ await occurs here, with `mut lock` maybe used later
8   | }
    | - `mut lock` is later dropped here
```

发生这种情况是因为 `std::sync::MutexGuard` 类型**不是** `Send` 的。这意味着你不能将互斥锁发送到另一个线程，并且发生错误是因为 Tokio 运行时可以在每个 `.await` 处将任务移动到不同线程之间。为了避免这种情况，你应该重构你的代码，使得互斥锁的析构函数在 `.await` 之前运行。

```rust
# use std::sync::{Mutex, MutexGuard};
// 这样可以！
async fn increment_and_do_stuff(mutex: &Mutex<i32>) {
    {
        let mut lock: MutexGuard<i32> = mutex.lock().unwrap();
        *lock += 1;
    } // lock 在此处离开作用域

    do_something_async().await;
}
# async fn do_something_async() {}
```

请注意，这样写不行：

```rust
use std::sync::{Mutex, MutexGuard};

// 这样也会失败。
async fn increment_and_do_stuff(mutex: &Mutex<i32>) {
    let mut lock: MutexGuard<i32> = mutex.lock().unwrap();
    *lock += 1;
    drop(lock);

    do_something_async().await;
}
# async fn do_something_async() {}
```

这是因为编译器目前仅基于作用域信息来计算 future 是否为 `Send`。希望编译器将来会更新以支持显式丢弃 (drop)，但目前，你必须显式使用作用域。

请注意，这里讨论的错误在[生成章节中的 Send 约束部分][send-bound]中也有讨论。

你不应该尝试通过以不需要任务为 `Send` 的方式生成任务来规避此问题，因为如果 Tokio 在任务持有锁时在 `.await` 处挂起你的任务，则可能会安排其他任务在同一线程上运行，并且这个其他任务也可能尝试锁定该互斥锁，这将导致死锁，因为等待锁定互斥锁的任务会阻止持有互斥锁的任务释放互斥锁。

请记住，一些互斥锁 crate 为它们的 MutexGuard 实现了 `Send`。在这种情况下，即使你在 `.await` 期间持有 MutexGuard，也没有编译器错误。代码可以编译，但它会死锁！

我们将在下面讨论一些避免这些问题的方法：

[send-bound]: spawning#send-bound

## 重构你的代码，避免在 `.await` 期间持有锁 (Restructure your code to not hold the lock across an `.await`)

处理互斥锁最安全的方法是将其包装在一个结构体中，并且仅在该结构体的非异步方法内部锁定互斥锁。

```rust
use std::sync::Mutex;

struct CanIncrement {
    mutex: Mutex<i32>,
}
impl CanIncrement {
    // 这个函数没有标记为 async。
    fn increment(&self) {
        let mut lock = self.mutex.lock().unwrap();
        *lock += 1;
    }
}

async fn increment_and_do_stuff(can_incr: &CanIncrement) {
    can_incr.increment();
    do_something_async().await;
}
# async fn do_something_async() {}
```

这种模式保证了你不会遇到 `Send` 错误，因为互斥锁守卫 (mutex guard) 不会出现在异步函数中的任何地方。当你使用其 `MutexGuard` 实现了 `Send` 的 crate 时，它也可以保护你免受死锁的困扰。

你可以在[这篇博客文章][shared-mutable-state-blog-post]中找到更详细的示例。

## 生成一个任务来管理状态，并使用消息传递来操作它 (Spawn a task to manage the state and use message passing to operate on it)

这是本章开头提到的第二种方法，通常在共享资源是 I/O 资源时使用。有关更多详细信息，请参见下一章。

## 使用 Tokio 的异步互斥锁 (Use Tokio's asynchronous mutex)

Tokio 提供的 [`tokio::sync::Mutex`] 类型也可以使用。Tokio 互斥锁的主要特性是它可以在 `.await` 期间持有而不会出现任何问题。也就是说，异步互斥锁比普通互斥锁更昂贵，并且通常最好使用其他两种方法之一。

```rust
use tokio::sync::Mutex; // 注意！这里使用的是 Tokio 的 mutex

// 这样可以编译！
// (但在这种情况下重构代码会更好)
async fn increment_and_do_stuff(mutex: &Mutex<i32>) {
    let mut lock = mutex.lock().await;
    *lock += 1;

    do_something_async().await;
} // lock 在此处离开作用域
# async fn do_something_async() {}
```

[`tokio::sync::Mutex`]: https://docs.rs/tokio/1/tokio/sync/struct.Mutex.html

# 任务、线程和争用 (Tasks, threads, and contention)

当争用最小时，使用阻塞互斥锁来保护短临界区是一种可接受的策略。当锁发生争用时，执行任务的线程必须阻塞并等待互斥锁。这不仅会阻塞当前任务，还会阻塞安排在当前线程上的所有其他任务。

默认情况下，Tokio 运行时使用多线程调度器。任务被安排在运行时管理的任意数量的线程上。如果大量任务被安排执行，并且它们都需要访问互斥锁，那么就会发生争用。另一方面，如果使用 [`current_thread`][current_thread] 运行时风格，则互斥锁永远不会发生争用。

> **信息** > [`current_thread` 运行时风格][basic-rt] 是一个轻量级的单线程运行时。当只生成少量任务并打开少量套接字时，这是一个不错的选择。例如，在异步客户端库之上提供同步 API 桥接时，此选项效果很好。

[basic-rt]: https://docs.rs/tokio/1/tokio/runtime/struct.Builder.html#method.new_current_thread

如果同步互斥锁上的争用成为一个问题，最好的解决方案很少是切换到 Tokio 互斥锁。相反，可以考虑的选项是：

- 让一个专用任务管理状态并使用消息传递。
- 对互斥锁进行分片 (shard)。
- 重构代码以避免使用互斥锁。

## 互斥锁分片 (Mutex sharding)

在我们的例子中，由于每个*键 (key)* 都是独立的，因此互斥锁分片会很好地工作。为此，我们将引入 `N` 个不同的实例，而不是只有一个 `Mutex<HashMap<_, _>>` 实例。

```rust
# use std::collections::HashMap;
# use std::sync::{Arc, Mutex};
type ShardedDb = Arc<Vec<Mutex<HashMap<String, Vec<u8>>>>>;

fn new_sharded_db(num_shards: usize) -> ShardedDb {
    let mut db = Vec::with_capacity(num_shards);
    for _ in 0..num_shards {
        db.push(Mutex::new(HashMap::new()));
    }
    Arc::new(db)
}
```

然后，查找任何给定键的单元格 (cell) 变成了一个两步过程。首先，使用键来确定它属于哪个分片 (shard)。然后，在 `HashMap` 中查找该键。

```rust,compile_fail
let shard = db[hash(key) % db.len()].lock().unwrap();
shard.insert(key, value);
```

上面概述的简单实现需要使用固定数量的分片，并且一旦创建了分片映射，分片的数量就不能更改。

[dashmap] crate 提供了更复杂的分片哈希映射的实现。你可能还想看看诸如 [leapfrog] 和 [flurry] 这样的并发哈希表实现，后者是 Java 的 `ConcurrentHashMap` 数据结构的移植版。

在你开始使用这些 crate 之前，请确保你的代码结构正确，这样你就不会在 `.await` 期间持有 `MutexGuard`。如果你不这样做，你将遇到编译器错误（对于非 Send 守卫）或你的代码将死锁（对于 Send 守卫）。请参阅[这篇博客文章][shared-mutable-state-blog-post]中的完整示例和更多上下文。

[current_thread]: https://docs.rs/tokio/1/tokio/runtime/index.html#current-thread-scheduler
[dashmap]: https://docs.rs/dashmap
[leapfrog]: https://docs.rs/leapfrog
[flurry]: https://docs.rs/flurry
[shared-mutable-state-blog-post]: https://draft.ryhl.io/blog/shared-mutable-state/
