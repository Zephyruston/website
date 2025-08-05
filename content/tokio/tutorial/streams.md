---
title: "流 (Streams)"
---

流 (Stream) 是一个异步的值序列。它相当于 Rust 中的 [`std::iter::Iterator`][iter] 的异步版本，并由 [`Stream`] trait 表示。流可以在 `async` 函数中进行迭代。它们也可以使用适配器 (adapter) 进行转换。Tokio 在 [`StreamExt`] trait 上提供了许多常见的适配器。

<!--
TODO: bring back once true again?
Tokio provides stream support under the `stream` feature flag. When depending on
Tokio, include either `stream` or `full` to get access to this functionality.
-->

Tokio 在一个独立的 crate 中提供流支持：`tokio-stream`。

```toml
tokio-stream = "0.1"
```

> **信息**
> 目前，Tokio 的流工具存在于 `tokio-stream` crate 中。
> 一旦 `Stream` trait 在 Rust 标准库中稳定下来，Tokio 的流工具将被移至 `tokio` crate。

<!--
TODO: uncomment this once it is true again.
A number of types we've already seen also implement [`Stream`]. For example, the
receive half of a [`mpsc::Receiver`][rx] implements [`Stream`]. The
[`AsyncBufReadExt::lines()`] method takes a buffered I/O reader and returns a
[`Stream`] where each value represents a line of data.
-->

# 迭代 (Iteration)

目前，Rust 编程语言不支持异步 `for` 循环。相反，流的迭代是通过 `while let` 循环与 [`StreamExt::next()`][next] 结合使用来完成的。

```rust
use tokio_stream::StreamExt;

#[tokio::main]
async fn main() {
    let mut stream = tokio_stream::iter(&[1, 2, 3]);

    while let Some(v) = stream.next().await {
        println!("GOT = {:?}", v);
    }
}
```

与迭代器类似，`next()` 方法返回 `Option<T>`，其中 `T` 是流的值类型。接收到 `None` 表示流迭代已终止。

## Mini-Redis 广播 (Broadcast)

让我们通过一个使用 Mini-Redis 客户端的稍微复杂一些的例子来了解一下。

完整代码可以在[这里][full]找到。

[full]: https://github.com/tokio-rs/website/blob/master/tutorial-code/streams/src/main.rs

```rust
use tokio_stream::StreamExt;
use mini_redis::client;

async fn publish() -> mini_redis::Result<()> {
    let mut client = client::connect("127.0.0.1:6379").await?;

    // 发布一些数据
    client.publish("numbers", "1".into()).await?;
    client.publish("numbers", "two".into()).await?;
    client.publish("numbers", "3".into()).await?;
    client.publish("numbers", "four".into()).await?;
    client.publish("numbers", "five".into()).await?;
    client.publish("numbers", "6".into()).await?;
    Ok(())
}

async fn subscribe() -> mini_redis::Result<()> {
    let client = client::connect("127.0.0.1:6379").await?;
    let subscriber = client.subscribe(vec!["numbers".to_string()]).await?;
    let messages = subscriber.into_stream();

    tokio::pin!(messages);

    while let Some(msg) = messages.next().await {
        println!("got = {:?}", msg);
    }

    Ok(())
}

# fn dox() {
#[tokio::main]
async fn main() -> mini_redis::Result<()> {
    tokio::spawn(async {
        publish().await
    });

    subscribe().await?;

    println!("DONE");

    Ok(())
}
# }
```

我们生成了一个任务，用于向 Mini-Redis 服务器的 "numbers" 频道发布消息。然后，在主任务中，我们订阅 "numbers" 频道并显示收到的消息。

订阅后，在返回的订阅者 (subscriber) 上调用 [`into_stream()`]。这会消耗 `Subscriber`，并返回一个流，该流在消息到达时产生这些消息。在开始迭代消息之前，请注意，该流使用 [`tokio::pin!`][`tokio::pin!`] [固定 (pinned)][pin] 在栈上。对流调用 `next()` 要求该流被[固定 (pinned)][pin]。`into_stream()` 函数返回一个*未*固定的流，我们必须显式地固定它才能迭代它。

> **信息**
> 当一个 Rust 值不能再在内存中移动时，它就是“被固定 (pinned)”的。被固定值的一个关键属性是，可以获取指向被固定数据的指针，并且调用者可以确信该指针保持有效。`async/await` 使用此特性来支持跨 `.await` 点借用数据。

如果我们忘记固定流，我们会收到如下错误：

```text
error[E0277]: `from_generator::GenFuture<[static generator@Subscriber::into_stream::{closure#0} for<'r, 's, 't0, 't1, 't2, 't3, 't4, 't5, 't6> {ResumeTy, &'r mut Subscriber, Subscriber, impl Future, (), std::result::Result<Option<Message>, Box<(dyn std::error::Error + Send + Sync + 't0)>>, Box<(dyn std::error::Error + Send + Sync + 't1)>, &'t2 mut async_stream::yielder::Sender<std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 't3)>>>, async_stream::yielder::Sender<std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 't4)>>>, std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 't5)>>, impl Future, Option<Message>, Message}]>` cannot be unpinned
  --> streams/src/main.rs:29:36
   |
29 |     while let Some(msg) = messages.next().await {
   |                                    ^^^^ within `tokio_stream::filter::_::__Origin<'_, impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>`, the trait `Unpin` is not implemented for `from_generator::GenFuture<[static generator@Subscriber::into_stream::{closure#0} for<'r, 's, 't0, 't1, 't2, 't3, 't4, 't5, 't6> {ResumeTy, &'r mut Subscriber, Subscriber, impl Future, (), std::result::Result<Option<Message>, Box<(dyn std::error::Error + Send + Sync + 't0)>>, Box<(dyn std::error::Error + Send + Sync + 't1)>, &'t2 mut async_stream::yielder::Sender<std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 't3)>>>, async_stream::yielder::Sender<std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 't4)>>>, std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 't5)>>, impl Future, Option<Message>, Message}]>`
   |
   = note: required because it appears within the type `impl Future`
   = note: required because it appears within the type `async_stream::async_stream::AsyncStream<std::result::Result<Message, Box<(dyn std::error::Error + Send + Sync + 'static)>>, impl Future>`
   = note: required because it appears within the type `impl Stream`
   = note: required because it appears within the type `tokio_stream::filter::_::__Origin<'_, impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>`
   = note: required because of the requirements on the impl of `Unpin` for `tokio_stream::filter::Filter<impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>`
   = note: required because it appears within the type `tokio_stream::map::_::__Origin<'_, tokio_stream::filter::Filter<impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>, [closure@streams/src/main.rs:26:14: 26:40]>`
   = note: required because of the requirements on the impl of `Unpin` for `tokio_stream::map::Map<tokio_stream::filter::Filter<impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>, [closure@streams/src/main.rs:26:14: 26:40]>`
   = note: required because of the requirements on the impl of `Unpin` for `tokio_stream::take::_::__Origin<'_, tokio_stream::map::Map<tokio_stream::filter::Filter<impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>, [closure@streams/src/main.rs:26:14: 26:40]>>`
   = note: required because of the requirements on the impl of `Unpin` for `tokio_stream::take::Take<tokio_stream::map::Map<tokio_stream::filter::Filter<impl Stream, [closure@streams/src/main.rs:22:17: 25:10]>, [closure@streams/src/main.rs:26:14: 26:40]>>`
```

如果你遇到这样的错误消息，请尝试固定该值！

在尝试运行此代码之前，请先启动 Mini-Redis 服务器：

```bash
$ mini-redis-server
```

然后尝试运行代码。我们将看到消息输出到 STDOUT。

```text
got = Ok(Message { channel: "numbers", content: b"1" })
got = Ok(Message { channel: "numbers", content: b"two" })
got = Ok(Message { channel: "numbers", content: b"3" })
got = Ok(Message { channel: "numbers", content: b"four" })
got = Ok(Message { channel: "numbers", content: b"five" })
got = Ok(Message { channel: "numbers", content: b"6" })
```

由于订阅和发布之间存在竞争条件，一些早期消息可能会丢失。程序永远不会退出。对 Mini-Redis 频道的订阅只要服务器处于活动状态就会保持活动状态。

让我们看看如何使用流来扩展这个程序。

# 适配器 (Adapters)

接受一个 [`Stream`] 并返回另一个 [`Stream`] 的函数通常被称为“流适配器 (stream adapters)”，因为它们是“适配器模式 (adapter pattern)”的一种形式。常见的流适配器包括 [`map`][`map`]、[`take`][`take`] 和 [`filter`][`filter`]。

让我们更新 Mini-Redis 示例，使其能够退出。在收到三条消息后，停止迭代消息。这是使用 [`take`][`take`] 完成的。此适配器将流限制为最多产生 `n` 条消息。

```rust
# use mini_redis::client;
# use tokio_stream::StreamExt;
# async fn subscribe() -> mini_redis::Result<()> {
#    let client = client::connect("127.0.0.1:6379").await?;
#    let subscriber = client.subscribe(vec!["numbers".to_string()]).await?;
let messages = subscriber
    .into_stream()
    .take(3);
#     Ok(())
# }
```

再次运行程序，我们得到：

```text
got = Ok(Message { channel: "numbers", content: b"1" })
got = Ok(Message { channel: "numbers", content: b"two" })
got = Ok(Message { channel: "numbers", content: b"3" })
```

这次程序结束了。

现在，让我们将流限制为单个数字。我们将通过检查消息长度来验证这一点。我们使用 [`filter`][`filter`] 适配器来丢弃任何不符合谓词的消息。

```rust
# use mini_redis::client;
# use tokio_stream::StreamExt;
# async fn subscribe() -> mini_redis::Result<()> {
#    let client = client::connect("127.0.0.1:6379").await?;
#    let subscriber = client.subscribe(vec!["numbers".to_string()]).await?;
let messages = subscriber
    .into_stream()
    .filter(|msg| match msg {
        Ok(msg) if msg.content.len() == 1 => true,
        _ => false,
    })
    .take(3);
#     Ok(())
# }
```

再次运行程序，我们得到：

```text
got = Ok(Message { channel: "numbers", content: b"1" })
got = Ok(Message { channel: "numbers", content: b"3" })
got = Ok(Message { channel: "numbers", content: b"6" })
```

请注意，应用适配器的顺序很重要。先调用 `filter` 再调用 `take` 与先调用 `take` 再调用 `filter` 是不同的。

最后，我们将通过剥离输出中的 `Ok(Message { ... })` 部分来整理输出。这是通过 [`map`][`map`] 完成的。因为这是在 `filter` **之后**应用的，所以我们知道消息是 `Ok`，因此我们可以使用 `unwrap()`。

```rust
# use mini_redis::client;
# use tokio_stream::StreamExt;
# async fn subscribe() -> mini_redis::Result<()> {
#    let client = client::connect("127.0.0.1:6379").await?;
#    let subscriber = client.subscribe(vec!["numbers".to_string()]).await?;
let messages = subscriber
    .into_stream()
    .filter(|msg| match msg {
        Ok(msg) if msg.content.len() == 1 => true,
        _ => false,
    })
    .map(|msg| msg.unwrap().content)
    .take(3);
#     Ok(())
# }
```

现在，输出是：

```text
got = b"1"
got = b"3"
got = b"6"
```

另一种选择是使用 [`filter_map`][`filter_map`] 将 [`filter`][`filter`] 和 [`map`][`map`] 步骤合并为单个调用。

还有更多可用的适配器。请参阅此处的列表 [`StreamExt`][`StreamExt`]。

# 实现 `Stream` (Implementing `Stream`)

[`Stream`] trait 与 [`Future`] trait 非常相似。

```rust
use std::pin::Pin;
use std::task::{Context, Poll};

pub trait Stream {
    type Item;

    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>
    ) -> Poll<Option<Self::Item>>;

    fn size_hint(&self) -> (usize, Option<usize>) {
        (0, None)
    }
}
```

`Stream::poll_next()` 函数与 `Future::poll` 非常相似，不同之处在于它可以被重复调用以从流中接收多个值。正如我们在[深入异步 (Async in depth)][async]中看到的，当流**未**准备好返回值时，将返回 `Poll::Pending`。任务的唤醒器 (waker) 会被注册。一旦应该再次轮询流，唤醒器就会被通知。

`size_hint()` 方法的使用方式与[迭代器 (iterators)][iter]中的相同。

通常，当手动实现 `Stream` 时，是通过组合 future 和其他流来完成的。例如，让我们以我们在[深入异步 (Async in depth)][async]中实现的 `Delay` future 为基础进行构建。我们将其转换为一个流，该流以 10 毫秒的间隔产生 `()` 三次。

```rust
use tokio_stream::Stream;
# use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
# use std::time::Instant;

struct Interval {
    rem: usize,
    delay: Delay,
}
# struct Delay { when: Instant }
# impl Future for Delay {
#   type Output = ();
#   fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
#       Poll::Pending
#   }
# }

impl Interval {
    fn new() -> Self {
        Self {
            rem: 3,
            delay: Delay { when: Instant::now() }
        }
    }
}

impl Stream for Interval {
    type Item = ();

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>)
        -> Poll<Option<()>>
    {
        if self.rem == 0 {
            // 不再有延迟
            return Poll::Ready(None);
        }

        match Pin::new(&mut self.delay).poll(cx) {
            Poll::Ready(_) => {
                let when = self.delay.when + Duration::from_millis(10);
                self.delay = Delay { when };
                self.rem -= 1;
                Poll::Ready(Some(()))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
```

## `async-stream`

使用 [`Stream`] trait 手动实现流可能很繁琐。不幸的是，Rust 编程语言尚不支持用于定义流的 `async/await` 语法。这项工作正在进行中，但尚未准备就绪。

[`async-stream`] crate 作为一个临时解决方案可用。此 crate 提供了一个 `stream!` 宏，可以将输入转换为流。使用此 crate，上面的间隔可以实现如下：

```rust
use async_stream::stream;
# use std::future::Future;
# use std::pin::Pin;
# use std::task::{Context, Poll};
# use tokio_stream::StreamExt;
use std::time::{Duration, Instant};

# struct Delay { when: Instant }
# impl Future for Delay {
#   type Output = ();
#   fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
#       Poll::Pending
#   }
# }
# async fn dox() {
# let stream =
stream! {
    let mut when = Instant::now();
    for _ in 0..3 {
        let delay = Delay { when };
        delay.await;
        yield ();
        when += Duration::from_millis(10);
    }
}
# ;
# tokio::pin!(stream);
# while let Some(_) = stream.next().await { }
# }
```

[iter]: https://doc.rust-lang.org/book/ch13-02-iterators.html
[`Stream`]: https://docs.rs/futures-core/0.3/futures_core/stream/trait.Stream.html
[`Future`]: https://doc.rust-lang.org/std/future/trait.Future.html
[`StreamExt`]: https://docs.rs/tokio-stream/0.1/tokio_stream/trait.StreamExt.html
[next]: https://docs.rs/tokio-stream/0.1/tokio_stream/trait.StreamExt.html#method.next
[`map`]: https://docs.rs/tokio-stream/0.1/tokio_stream/trait.StreamExt.html#method.map
[`take`]: https://docs.rs/tokio-stream/0.1/tokio_stream/trait.StreamExt.html#method.take
[`filter`]: https://docs.rs/tokio-stream/0.1/tokio_stream/trait.StreamExt.html#method.filter
[`filter_map`]: https://docs.rs/tokio-stream/0.1/tokio_stream/trait.StreamExt.html#method.filter_map
[pin]: https://doc.rust-lang.org/std/pin/index.html
[async]: async.md
[`async-stream`]: https://docs.rs/async-stream
[`into_stream()`]: https://docs.rs/mini-redis/0.4/mini_redis/client/struct.Subscriber.html#method.into_stream
[`tokio::pin!`]: https://docs.rs/tokio/1/tokio/macro.pin.html
