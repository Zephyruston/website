---
title: "通道 (Channels)"
---

现在我们已经学习了关于 Tokio 并发的一些知识，让我们在客户端应用这些知识。将我们之前编写的服务器代码放入一个显式的二进制文件中：

```bash
$ mkdir src/bin
$ mv src/main.rs src/bin/server.rs
```

并创建一个新的二进制文件来包含客户端代码：

```bash
$ touch src/bin/client.rs
```

在此文件中，你将编写本页的代码。无论何时你想运行它，都必须先在单独的终端窗口中启动服务器：

```bash
$ cargo run --bin server
```

然后运行客户端，**分开运行**：

```bash
$ cargo run --bin client
```

话虽如此，让我们开始编码吧！

假设我们想运行两个并发的 Redis 命令。我们可以为每个命令生成一个任务。然后这两个命令将并发执行。

起初，我们可能会尝试这样写：

```rust,compile_fail
use mini_redis::client;

#[tokio::main]
async fn main() {
    // 建立与服务器的连接
    let mut client = client::connect("127.0.0.1:6379").await.unwrap();

    // 生成两个任务，一个获取键，另一个设置键
    let t1 = tokio::spawn(async {
        let res = client.get("foo").await;
    });

    let t2 = tokio::spawn(async {
        client.set("foo", "bar".into()).await;
    });

    t1.await.unwrap();
    t2.await.unwrap();
}
```

这无法编译，因为两个任务都需要以某种方式访问 `client`。由于 `Client` 没有实现 `Copy`，因此如果没有一些代码来促进这种共享，它将无法编译。此外，`Client::set` 接收 `&mut self`，这意味着调用它需要独占访问 (exclusive access)。我们可以为每个任务打开一个连接，但这并不理想。我们不能使用 `std::sync::Mutex`，因为需要在持有锁时调用 `.await`。我们可以使用 `tokio::sync::Mutex`，但这只允许单个进行中的请求。如果客户端实现了[管道 (pipelining)][pipelining]（简而言之，发送许多命令而无需等待每个先前命令的响应），异步互斥锁会导致连接利用率不足。

[pipelining]: https://redis.io/topics/pipelining

# 消息传递 (Message passing)

答案是使用消息传递。该模式涉及生成一个专用任务来管理 `client` 资源。任何希望发出请求的任务都会向 `client` 任务发送一条消息。`client` 任务代表发送者发出请求，并将响应发送回发送者。

使用此策略，将建立一个连接。管理 `client` 的任务能够获得独占访问权限，以便调用 `get` 和 `set`。此外，通道充当缓冲区。可以在 `client` 任务忙时向其发送操作。一旦 `client` 任务可用于处理新请求，它就会从通道中拉取下一个请求。这可以提高吞吐量，并扩展为支持连接池 (connection pooling)。

# Tokio 的通道原语 (Tokio's channel primitives)

Tokio 提供了[多种通道][channels]，每种通道都有不同的用途。

- [mpsc]: 多生产者，单消费者通道。可以发送多个值。
- [oneshot]: 单生产者，单消费者通道。只能发送一个值。
- [broadcast]: 多生产者，多消费者。可以发送多个值。每个接收者都能看到每个值。
- [watch]: 多生产者，多消费者。可以发送多个值，但不保留历史记录。接收者只看到最新的值。

如果你需要一个多生产者多消费者通道，并且只有一个消费者能看到每条消息，你可以使用 [`async-channel`] crate。还有用于异步 Rust 之外的通道，例如 [`std::sync::mpsc`] 和 [`crossbeam::channel`]。这些通道通过阻塞线程来等待消息，这在异步代码中是不允许的。

在本节中，我们将使用 [mpsc] 和 [oneshot]。其他类型的消息传递通道将在后面的章节中探讨。本节的完整代码在[这里][full]。

[channels]: https://docs.rs/tokio/1/tokio/sync/index.html
[mpsc]: https://docs.rs/tokio/1/tokio/sync/mpsc/index.html
[oneshot]: https://docs.rs/tokio/1/tokio/sync/oneshot/index.html
[broadcast]: https://docs.rs/tokio/1/tokio/sync/broadcast/index.html
[watch]: https://docs.rs/tokio/1/tokio/sync/watch/index.html
[`async-channel`]: https://docs.rs/async-channel/
[`std::sync::mpsc`]: https://doc.rust-lang.org/stable/std/sync/mpsc/index.html
[`crossbeam::channel`]: https://docs.rs/crossbeam/latest/crossbeam/channel/index.html

# 定义消息类型 (Define the message type)

在大多数情况下，使用消息传递时，接收消息的任务会响应多个命令。在我们的例子中，任务将响应 `GET` 和 `SET` 命令。为了对此进行建模，我们首先定义一个 `Command` 枚举，并为每个命令类型包含一个变体。

```rust
use bytes::Bytes;

#[derive(Debug)]
enum Command {
    Get {
        key: String,
    },
    Set {
        key: String,
        val: Bytes,
    }
}
```

# 创建通道 (Create the channel)

在 `main` 函数中，创建一个 `mpsc` 通道。

```rust
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    // 创建一个容量最多为 32 的新通道。
    let (tx, mut rx) = mpsc::channel(32);
# tx.send(()).await.unwrap();

    // ... 其余代码在这里
}
```

`mpsc` 通道用于向管理 redis 连接的任务**发送 (send)** 命令。多生产者功能允许从许多任务发送消息。创建通道会返回两个值，一个发送者 (sender) 和一个接收者 (receiver)。这两个句柄是分开使用的。它们可以被移动到不同的任务中。

通道的创建容量为 32。如果消息发送的速度快于接收的速度，通道将存储它们。一旦 32 条消息存储在通道中，调用 `send(...).await` 将进入睡眠状态，直到消息被接收者移除。

从多个任务发送是通过**克隆 (cloning)** `Sender` 来完成的。例如：

```rust
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    let (tx, mut rx) = mpsc::channel(32);
    let tx2 = tx.clone();

    tokio::spawn(async move {
        tx.send("sending from first handle").await.unwrap();
    });

    tokio::spawn(async move {
        tx2.send("sending from second handle").await.unwrap();
    });

    while let Some(message) = rx.recv().await {
        println!("GOT = {}", message);
    }
}
```

两条消息都发送到单个 `Receiver` 句柄。无法克隆 `mpsc` 通道的接收者。

当每个 `Sender` 都离开作用域或以其他方式被丢弃 (drop) 后，就不再可能向通道发送更多消息。此时，`Receiver` 上的 `recv` 调用将返回 `None`，这意味着所有发送者都已消失，通道已关闭。

在我们管理 Redis 连接的任务的情况下，它知道一旦通道关闭就可以关闭 Redis 连接，因为该连接将不再被使用。

# 生成管理器任务 (Spawn manager task)

接下来，生成一个处理来自通道的消息的任务。首先，建立一个到 Redis 的客户端连接。然后，通过 Redis 连接发出接收到的命令。

```rust
use mini_redis::client;
# enum Command {
#    Get { key: String },
#    Set { key: String, val: bytes::Bytes }
# }
# async fn dox() {
# let (_, mut rx) = tokio::sync::mpsc::channel(10);
// `move` 关键字用于将 `rx` 的所有权**移动 (move)**到任务中。
let manager = tokio::spawn(async move {
    // 建立与服务器的连接
    let mut client = client::connect("127.0.0.1:6379").await.unwrap();

    // 开始接收消息
    while let Some(cmd) = rx.recv().await {
        use Command::*;

        match cmd {
            Get { key } => {
                client.get(&key).await;
            }
            Set { key, val } => {
                client.set(&key, val).await;
            }
        }
    }
});
# }
```

现在，更新这两个任务，通过通道发送命令，而不是直接在 Redis 连接上发出命令。

```rust
# #[derive(Debug)]
# enum Command {
#    Get { key: String },
#    Set { key: String, val: bytes::Bytes }
# }
# async fn dox() {
# let (mut tx, _) = tokio::sync::mpsc::channel(10);
// `Sender` 句柄被移动到任务中。由于有两个任务，我们需要第二个 `Sender`。
let tx2 = tx.clone();

// 生成两个任务，一个获取键，另一个设置键
let t1 = tokio::spawn(async move {
    let cmd = Command::Get {
        key: "foo".to_string(),
    };

    tx.send(cmd).await.unwrap();
});

let t2 = tokio::spawn(async move {
    let cmd = Command::Set {
        key: "foo".to_string(),
        val: "bar".into(),
    };

    tx2.send(cmd).await.unwrap();
});
# }
```

在 `main` 函数的底部，我们 `.await` 连接句柄 (join handles)，以确保在进程退出之前命令完全完成。

```rust
# type Jh = tokio::task::JoinHandle<()>;
# async fn dox(t1: Jh, t2: Jh, manager: Jh) {
t1.await.unwrap();
t2.await.unwrap();
manager.await.unwrap();
# }
```

# 接收响应 (Receive responses)

最后一步是从管理器任务接收响应。`GET` 命令需要获取值，`SET` 命令需要知道操作是否成功完成。

为了传递响应，使用了一个 `oneshot` 通道。`oneshot` 通道是一个单生产者、单消费者通道，针对发送单个值进行了优化。在我们的例子中，单个值就是响应。

与 `mpsc` 类似，`oneshot::channel()` 返回一个发送者和接收者句柄。

```rust
use tokio::sync::oneshot;

# async fn dox() {
let (tx, rx) = oneshot::channel();
# tx.send(()).unwrap();
# }
```

与 `mpsc` 不同，没有指定容量，因为容量始终为 1。此外，两个句柄都不能被克隆。

为了从管理器任务接收响应，在发送命令之前，会创建一个 `oneshot` 通道。通道的 `Sender` 部分包含在发送给管理器任务的命令中。接收部分用于接收响应。

首先，更新 `Command` 以包含 `Sender`。为方便起见，使用类型别名来引用 `Sender`。

```rust
use tokio::sync::oneshot;
use bytes::Bytes;

/// 多种不同的命令在单个通道上多路复用。
#[derive(Debug)]
enum Command {
    Get {
        key: String,
        resp: Responder<Option<Bytes>>,
    },
    Set {
        key: String,
        val: Bytes,
        resp: Responder<()>,
    },
}

/// 由请求者提供，并由管理器任务用于将命令响应发送回请求者。
type Responder<T> = oneshot::Sender<mini_redis::Result<T>>;
```

现在，更新发出命令的任务以包含 `oneshot::Sender`。

```rust
# use tokio::sync::{oneshot, mpsc};
# use bytes::Bytes;
# #[derive(Debug)]
# enum Command {
#     Get { key: String, resp: Responder<Option<bytes::Bytes>> },
#     Set { key: String, val: Bytes, resp: Responder<()> },
# }
# type Responder<T> = oneshot::Sender<mini_redis::Result<T>>;
# fn dox() {
# let (mut tx, mut rx) = mpsc::channel(10);
# let mut tx2 = tx.clone();
let t1 = tokio::spawn(async move {
    let (resp_tx, resp_rx) = oneshot::channel();
    let cmd = Command::Get {
        key: "foo".to_string(),
        resp: resp_tx,
    };

    // 发送 GET 请求
    tx.send(cmd).await.unwrap();

    // 等待响应
    let res = resp_rx.await;
    println!("GOT = {:?}", res);
});

let t2 = tokio::spawn(async move {
    let (resp_tx, resp_rx) = oneshot::channel();
    let cmd = Command::Set {
        key: "foo".to_string(),
        val: "bar".into(),
        resp: resp_tx,
    };

    // 发送 SET 请求
    tx2.send(cmd).await.unwrap();

    // 等待响应
    let res = resp_rx.await;
    println!("GOT = {:?}", res);
});
# }
```

最后，更新管理器任务，通过 `oneshot` 通道发送响应。

```rust
# use tokio::sync::{oneshot, mpsc};
# use bytes::Bytes;
# #[derive(Debug)]
# enum Command {
#     Get { key: String, resp: Responder<Option<bytes::Bytes>> },
#     Set { key: String, val: Bytes, resp: Responder<()> },
# }
# type Responder<T> = oneshot::Sender<mini_redis::Result<T>>;
# async fn dox(mut client: mini_redis::client::Client) {
# let (_, mut rx) = mpsc::channel::<Command>(10);
while let Some(cmd) = rx.recv().await {
    match cmd {
        Command::Get { key, resp } => {
            let res = client.get(&key).await;
            // 忽略错误
            let _ = resp.send(res);
        }
        Command::Set { key, val, resp } => {
            let res = client.set(&key, val).await;
            // 忽略错误
            let _ = resp.send(res);
        }
    }
}
# }
```

在 `oneshot::Sender` 上调用 `send` 会立即完成，并且**不 (not)** 需要 `.await`。这是因为 `oneshot` 通道上的 `send` 总是会立即失败或成功，而无需任何形式的等待。

当接收者部分被丢弃时，在 oneshot 通道上发送值会返回 `Err`。这表明接收者不再对响应感兴趣。在我们的场景中，接收者取消兴趣是一个可接受的事件。`resp.send(...)` 返回的 `Err` 不需要被处理。

你可以在[这里][full]找到整个代码。

# 背压 (Backpressure) 和有界通道 (bounded channels)

每当引入并发或排队时，重要的是确保排队是有界的，并且系统能够优雅地处理负载。无界队列最终会填满所有可用内存，并导致系统以不可预测的方式失败。

Tokio 注意避免隐式排队。其中一个很大原因是异步操作是惰性的 (lazy)。考虑以下内容：

```rust
# fn async_op() {}
# fn dox() {
loop {
    async_op();
}
# }
# fn main() {}
```

如果异步操作是急切 (eager) 运行的，循环将重复排队一个新的 `async_op` 来运行，而不确保前一个操作完成。这会导致隐式的无界排队。基于回调的系统以及基于**急切 (eager)** future 的系统尤其容易受到此问题的影响。

然而，使用 Tokio 和异步 Rust，上面的代码片段将**不会 (not)** 导致 `async_op` 运行。这是因为从未调用 `.await`。如果代码片段更新为使用 `.await`，那么循环会等待操作完成后再重新开始。

```rust
# async fn async_op() {}
# async fn dox() {
loop {
    // 在 `async_op` 完成之前不会重复
    async_op().await;
}
# }
# fn main() {}
```

并发和排队必须显式引入。这样做的方法包括：

- `tokio::spawn`
- `select!`
- `join!`
- `mpsc::channel`

这样做时，请注意确保总的并发量是有界的。例如，在编写 TCP 接受循环时，确保打开的套接字总数是有界的。使用 `mpsc::channel` 时，选择一个可管理的通道容量。特定的边界值将是特定于应用程序的。

小心并选择好的边界是编写可靠的 Tokio 应用程序的重要组成部分。

[full]: https://github.com/tokio-rs/website/blob/master/tutorial-code/channels/src/main.rs
