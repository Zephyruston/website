---
title: "与同步代码桥接"
---

在大多数使用 Tokio 的示例中，我们使用 `#[tokio::main]` 标记 main 函数，
并将整个项目设置为异步。

在某些情况下，您可能需要运行一小部分同步代码。有关更多信息，
请参见 [`spawn_blocking`]。

在其他情况下，将应用程序构建为大体上是同步的，
而较小或逻辑上独立的异步部分可能更容易。
例如，GUI 应用程序可能希望在主线程上运行 GUI 代码，
并在另一个线程上并行运行 Tokio 运行时。

本页说明了如何将 async/await 隔离到项目的一小部分。

# `#[tokio::main]` 展开后的内容

`#[tokio::main]` 宏是一个宏，它用一个非异步的 main 函数替换您的 main 函数，
该函数启动一个运行时，然后调用您的代码。例如，
这个：

```rust
#[tokio::main]
async fn main() {
    println!("Hello world");
}
```

会被宏转换为这样：

```rust
fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            println!("Hello world");
        })
}
```

为了在我们自己的项目中使用 async/await，我们可以做类似的事情，
利用 [`block_on`] 方法在适当的时候进入异步上下文。

# mini-redis 的同步接口

在本节中，我们将介绍如何通过存储 `Runtime` 对象并使用其 `block_on` 方法
来构建 mini-redis 的同步接口。
在接下来的几节中，我们将讨论一些替代方法以及何时应该使用每种方法。

我们将要包装的接口是异步的 [`Client`] 类型。
它有几个方法，我们将为以下方法实现一个阻塞版本：

- [`Client::get`]
- [`Client::set`]
- [`Client::set_expires`]
- [`Client::publish`]
- [`Client::subscribe`]

为此，我们引入一个名为 `src/clients/blocking_client.rs` 的新文件，
并使用一个围绕异步 `Client` 类型的包装结构体来初始化它：

```rs
use tokio::net::ToSocketAddrs;
use tokio::runtime::Runtime;

pub use crate::clients::client::Message;

/// 与 Redis 服务器建立的连接。
pub struct BlockingClient {
    /// 异步的 `Client`。
    inner: crate::clients::Client,

    /// 一个 `current_thread` 运行时，用于以阻塞方式
    /// 执行异步客户端上的操作。
    rt: Runtime,
}

impl BlockingClient {
    pub fn connect<T: ToSocketAddrs>(addr: T) -> crate::Result<BlockingClient> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;

        // 使用运行时调用异步的 connect 方法。
        let inner = rt.block_on(crate::clients::Client::connect(addr))?;

        Ok(BlockingClient { inner, rt })
    }
}
```

在这里，我们将构造函数包含在内，作为如何在非异步上下文中
执行异步方法的第一个示例。我们使用 Tokio [`Runtime`] 类型的
[`block_on`] 方法来做到这一点，该方法执行一个异步方法并返回其结果。

一个重要的细节是使用了 [`current_thread`] 运行时。
通常在使用 Tokio 时，您会使用默认的 [`multi_thread`] 运行时，
它会生成一堆后台线程，以便可以同时高效地运行许多任务。
对于我们的用例，我们一次只做一件事，所以运行多个线程不会有任何好处。
这使得 [`current_thread`] 运行时成为完美选择，因为它不生成任何线程。

[`enable_all`] 调用会启用 Tokio 运行时上的 IO 和定时器驱动程序。
如果未启用，运行时将无法执行 IO 或定时器操作。

> **警告**
> 因为 `current_thread` 运行时不生成线程，所以它只在调用 `block_on` 时运行。
> 一旦 `block_on` 返回，该运行时上所有已 spawn 的任务都将冻结，直到您再次调用 `block_on`。
> 如果已 spawn 的任务必须在未调用 `block_on` 时保持运行，请使用 `multi_threaded` 运行时。

一旦我们有了这个结构体，大多数方法都很容易实现：

```rs
use bytes::Bytes;
use std::time::Duration;

impl BlockingClient {
    pub fn get(&mut self, key: &str) -> crate::Result<Option<Bytes>> {
        self.rt.block_on(self.inner.get(key))
    }

    pub fn set(&mut self, key: &str, value: Bytes) -> crate::Result<()> {
        self.rt.block_on(self.inner.set(key, value))
    }

    pub fn set_expires(
        &mut self,
        key: &str,
        value: Bytes,
        expiration: Duration,
    ) -> crate::Result<()> {
        self.rt.block_on(self.inner.set_expires(key, value, expiration))
    }

    pub fn publish(&mut self, channel: &str, message: Bytes) -> crate::Result<u64> {
        self.rt.block_on(self.inner.publish(channel, message))
    }
}
```

[`Client::subscribe`] 方法更有趣，因为它将 `Client` 转换为 `Subscriber` 对象。
我们可以按以下方式实现它：

```rs
/// 已进入发布/订阅模式的客户端。
///
/// 一旦客户端订阅了频道，它们就只能执行与发布/订阅相关的命令。
/// `BlockingClient` 类型被转换为 `BlockingSubscriber` 类型，
/// 以防止调用非发布/订阅相关的方法。
pub struct BlockingSubscriber {
    /// 异步的 `Subscriber`。
    inner: crate::clients::Subscriber,

    /// 一个 `current_thread` 运行时，用于以阻塞方式
    /// 执行异步客户端上的操作。
    rt: Runtime,
}

impl BlockingClient {
    pub fn subscribe(self, channels: Vec<String>) -> crate::Result<BlockingSubscriber> {
        let subscriber = self.rt.block_on(self.inner.subscribe(channels))?;
        Ok(BlockingSubscriber {
            inner: subscriber,
            rt: self.rt,
        })
    }
}

impl BlockingSubscriber {
    pub fn get_subscribed(&self) -> &[String] {
        self.inner.get_subscribed()
    }

    pub fn next_message(&mut self) -> crate::Result<Option<Message>> {
        self.rt.block_on(self.inner.next_message())
    }

    pub fn subscribe(&mut self, channels: &[String]) -> crate::Result<()> {
        self.rt.block_on(self.inner.subscribe(channels))
    }

    pub fn unsubscribe(&mut self, channels: &[String]) -> crate::Result<()> {
        self.rt.block_on(self.inner.unsubscribe(channels))
    }
}
```

因此，`subscribe` 方法将首先使用运行时将异步的 `Client` 转换为异步的 `Subscriber`。
然后，它将生成的 `Subscriber` 与 `Runtime` 一起存储，并使用 [`block_on`] 实现各种方法。

请注意，异步的 `Subscriber` 结构体有一个名为 `get_subscribed` 的非异步方法。
为了处理这个问题，我们直接调用它，而不涉及运行时。

# 其他方法

上一节解释了实现同步包装器最简单的方法，但这并不是唯一的方法。
这些方法包括：

- 创建一个 [`Runtime`] 并在异步代码上调用 [`block_on`]。
- 创建一个 [`Runtime`] 并在其上 [`spawn`] 任务。
- 在单独的线程中运行 [`Runtime`] 并向其发送消息。

我们已经看到了第一种方法。下面概述了另外两种方法。

## 在运行时上生成任务

[`Runtime`] 对象有一个名为 [`spawn`] 的方法。
当您调用此方法时，您会创建一个新的后台任务在运行时上运行。
例如：

```rust
use tokio::runtime::Builder;
use tokio::time::{sleep, Duration};

fn main() {
    let runtime = Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();

    let mut handles = Vec::with_capacity(10);
    for i in 0..10 {
        handles.push(runtime.spawn(my_bg_task(i)));
    }

    // 在后台任务执行时做一些耗时的事情。
    std::thread::sleep(Duration::from_millis(750));
    println!("Finished time-consuming task.");

    // 等待它们全部完成。
    for handle in handles {
        // `spawn` 方法返回一个 `JoinHandle`。`JoinHandle` 是一个 future，
        // 所以我们可以使用 `block_on` 等待它。
        runtime.block_on(handle).unwrap();
    }
}

async fn my_bg_task(i: u64) {
    // 通过减法，i 值较大的任务睡眠时间较短。
    let millis = 1000 - 50 * i;
    println!("Task {} sleeping for {} ms.", i, millis);

    sleep(Duration::from_millis(millis)).await;

    println!("Task {} stopping.", i);
}
```

```text
Task 0 sleeping for 1000 ms.
Task 1 sleeping for 950 ms.
Task 2 sleeping for 900 ms.
Task 3 sleeping for 850 ms.
Task 4 sleeping for 800 ms.
Task 5 sleeping for 750 ms.
Task 6 sleeping for 700 ms.
Task 7 sleeping for 650 ms.
Task 8 sleeping for 600 ms.
Task 9 sleeping for 550 ms.
Task 9 stopping.
Task 8 stopping.
Task 7 stopping.
Task 6 stopping.
Finished time-consuming task.
Task 5 stopping.
Task 4 stopping.
Task 3 stopping.
Task 2 stopping.
Task 1 stopping.
Task 0 stopping.
```

在上面的例子中，我们在运行时上生成了 10 个后台任务，然后等待它们全部完成。
例如，这可以是在图形应用程序中实现后台网络请求的好方法，
因为网络请求太耗时，无法在主 GUI 线程上运行。
相反，您在后台运行的 Tokio 运行时上生成请求，
并让任务在请求完成时（甚至如果您想要进度条，则可以增量地）
将信息发送回 GUI 代码。

在这个例子中，重要的是运行时被配置为 [`multi_thread`] 运行时。
如果将其更改为 [`current_thread`] 运行时，您会发现耗时的任务在任何后台任务开始之前就完成了。
这是因为在 `current_thread` 运行时上生成的后台任务只会在调用 `block_on` 期间执行，
因为否则运行时没有地方可以运行它们。

该示例通过在调用 [`spawn`] 返回的 [`JoinHandle`] 上调用 `block_on` 来等待已生成的任务完成，
但这并不是唯一的方法。这里有一些替代方案：

- 使用消息传递通道，例如 [`tokio::sync::mpsc`]。
- 修改受例如 `Mutex` 保护的共享值。对于 GUI 中的进度条，这可能是一个好方法，
  GUI 每帧读取共享值。

`spawn` 方法在 [`Handle`] 类型上也可用。
可以克隆 `Handle` 类型以获得多个运行时句柄，并且每个 `Handle` 都可用于在运行时上生成新任务。

## 发送消息

第三种方法是生成一个运行时并使用消息传递与其通信。
这比前两种方法涉及更多的样板代码，但它是最灵活的方法。
您可以在下面找到一个基本示例：

```rust
use tokio::runtime::Builder;
use tokio::sync::mpsc;

pub struct Task {
    name: String,
    // 描述任务的信息
}

async fn handle_task(task: Task) {
    println!("Got task {}", task.name);
}

#[derive(Clone)]
pub struct TaskSpawner {
    spawn: mpsc::Sender<Task>,
}

impl TaskSpawner {
    pub fn new() -> TaskSpawner {
        // 设置一个用于通信的通道。
        let (send, mut recv) = mpsc::channel(16);

        // 为新线程构建运行时。
        //
        // 运行时在生成线程之前创建，
        // 以便在 `unwrap()` 发生 panic 时更清晰地转发错误。
        let rt = Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        std::thread::spawn(move || {
            rt.block_on(async move {
                while let Some(task) = recv.recv().await {
                    tokio::spawn(handle_task(task));
                }

                // 一旦所有发送者都超出作用域，
                // `.recv()` 调用将返回 None，并且它将
                // 退出 while 循环并关闭线程。
            });
        });

        TaskSpawner {
            spawn: send,
        }
    }

    pub fn spawn_task(&self, task: Task) {
        match self.spawn.blocking_send(task) {
            Ok(()) => {},
            Err(_) => panic!("The shared runtime has shut down."),
        }
    }
}
```

这个例子可以通过多种方式进行配置。
例如，您可以使用 [`Semaphore`] 来限制活动任务的数量，
或者您可以使用相反方向的通道向生成器发送响应。
当您以这种方式生成运行时时，它是一种 [actor]。

[`Runtime`]: https://docs.rs/tokio/1/tokio/runtime/struct.Runtime.html
[`block_on`]: https://docs.rs/tokio/1/tokio/runtime/struct.Runtime.html#method.block_on
[`spawn`]: https://docs.rs/tokio/1/tokio/runtime/struct.Runtime.html#method.spawn
[`spawn_blocking`]: https://docs.rs/tokio/1/tokio/task/fn.spawn_blocking.html
[`multi_thread`]: https://docs.rs/tokio/1/tokio/runtime/struct.Builder.html#method.new_multi_thread
[`current_thread`]: https://docs.rs/tokio/1/tokio/runtime/struct.Builder.html#method.new_current_thread
[`enable_all`]: https://docs.rs/tokio/1/tokio/runtime/struct.Builder.html#method.enable_all
[`JoinHandle`]: https://docs.rs/tokio/1/tokio/task/struct.JoinHandle.html
[`tokio::sync::mpsc`]: https://docs.rs/tokio/1/tokio/sync/mpsc/index.html
[`Handle`]: https://docs.rs/tokio/1/tokio/runtime/struct.Handle.html
[`Semaphore`]: https://docs.rs/tokio/1/tokio/sync/struct.Semaphore.html
[`Client`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Client.html
[`Client::get`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Client.html#method.get
[`Client::set`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Client.html#method.set
[`Client::set_expires`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Client.html#method.set_expires
[`Client::publish`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Client.html#method.publish
[`Client::subscribe`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Client.html#method.subscribe
[actor]: https://ryhl.io/blog/actors-with-tokio/
