---
title: 术语表
---

## 异步 (Asynchronous)

在 Rust 的上下文中，异步代码指的是使用 async/await 语言特性的代码，
该特性允许许多任务在少量线程（甚至单个线程）上并发运行。

## 并发与并行 (Concurrency and parallelism)

并发和并行是两个相关的概念，在谈论同时执行多个任务时都会用到。
如果某件事是并行发生的，那么它也是并发发生的，但反过来就不一样了：
在两个任务之间交替执行，但从未同时在两个任务上工作，这是并发而不是并行。

## Future (未来值)

Future 是一个存储某个操作当前状态的值。Future 还有一个 `poll` 方法，
该方法使操作继续进行，直到它需要等待某些东西，例如网络连接。
对 `poll` 方法的调用应该非常快地返回。

Future 通常通过在异步块中使用 `.await` 组合多个 Future 来创建。

## 执行器/调度器 (Executor/scheduler)

执行器或调度器是通过重复调用 `poll` 方法来执行 Future 的东西。
标准库中没有执行器，因此您需要一个外部库，最广泛使用的执行器由 Tokio 运行时提供。

执行器能够在少量线程上并发运行大量 Future。它通过在 await 点交换当前运行的任务来实现这一点。
如果代码在没有到达 `.await` 的情况下花费很长时间，这被称为“阻塞线程”或“不将控制权交还给执行器”，这会阻止其他任务运行。

## 运行时 (Runtime)

运行时是一个包含执行器以及与该执行器集成的各种实用程序的库，
例如计时实用程序和 IO。运行时和执行器这两个词有时可以互换使用。
标准库没有运行时，因此您需要一个外部库，最广泛使用的运行时是 Tokio 运行时。

“Runtime”这个词也用在其他上下文中，例如，“Rust 没有运行时”这句话有时用来表示 Rust 不执行垃圾回收或即时编译。

## 任务 (Task)

任务是在 Tokio 运行时上运行的操作，由 [`tokio::spawn`] 或 [`Runtime::block_on`] 函数创建。
通过 `.await` 和 [`join!`] 等方式组合 Future 来创建 Future 的工具不会创建新的任务，
并且每个组合的部分被称为“在同一个任务中”。

并行需要多个任务，但也可以使用 `join!` 等工具在一个任务上并发执行多项操作。

[`Runtime::block_on`]: https://docs.rs/tokio/1/tokio/runtime/struct.Runtime.html#method.block_on
[`join!`]: https://docs.rs/tokio/1/tokio/macro.join.html

## 生成 (Spawning)

生成是指使用 [`tokio::spawn`] 函数创建新任务。它也可以指使用 [`std::thread::spawn`] 创建新线程。

[`tokio::spawn`]: https://docs.rs/tokio/1/tokio/fn.spawn.html
[`std::thread::spawn`]: https://doc.rust-lang.org/stable/std/thread/fn.spawn.html

## 异步块 (Async block)

异步块是创建运行某些代码的 Future 的一种简单方法。例如：

```rust
let world = async {
    println!(" world!");
};
let my_future = async {
    print!("Hello ");
    world.await;
};
```

上面的代码创建了一个名为 `my_future` 的 Future，如果执行它会打印 `Hello world!`。
它首先打印 hello，然后运行 `world` Future。请注意，上面的代码本身不会打印任何内容——
您必须通过直接生成它，或者在您生成的内容中 `.await` 它来实际执行 `my_future`，然后才会发生任何事情。

## 异步函数 (Async function)

与异步块类似，异步函数是创建一个函数的简单方法，该函数的主体成为一个 Future。
所有异步函数都可以重写为返回 Future 的普通函数：

```rust
async fn do_stuff(i: i32) -> String {
    // 执行一些操作
    format!("The integer is {}.", i)
}
```

```rust
use std::future::Future;

// 上面的异步函数与此相同：
fn do_stuff(i: i32) -> impl Future<Output = String> {
    async move {
        // 执行一些操作
        format!("The integer is {}.", i)
    }
}
```

这使用了 [`impl Trait` 语法][book10-02] 来返回一个 Future，因为 [`Future`] 是一个 trait。
请注意，由于异步块创建的 Future 在执行之前不会执行任何操作，因此调用异步函数在它返回的 Future 被执行之前也不会执行任何操作
[（忽略它会触发警告）][unused-warning]。

[book10-02]: https://doc.rust-lang.org/book/ch10-02-traits.html#returning-types-that-implement-traits
[`Future`]: https://doc.rust-lang.org/stable/std/future/trait.Future.html
[unused-warning]: https://play.rust-lang.org/?version=stable&mode=debug&edition=2018&gist=4faf44e08b4a3bb1269a7985460f1923

## 让出 (Yielding)

在异步 Rust 的上下文中，让出是允许执行器在单个线程上执行许多 Future 的原因。
每次 Future 让出时，执行器能够将该 Future 与其他某个 Future 交换，并且通过重复交换当前任务，
执行器可以并发执行大量任务。Future 只能在 `.await` 处让出，因此在 `.await` 之间花费很长时间的 Future 会阻止其他任务运行。

具体来说，Future 每当从 [`poll`] 方法返回时就会让出。

[`poll`]: https://doc.rust-lang.org/stable/std/future/trait.Future.html#method.poll

## 阻塞 (Blocking)

“阻塞”这个词有两种不同的用法：“阻塞”的第一个意思仅仅是等待某事完成，
而阻塞的另一个意思是 Future 在不让出的情况下花费很长时间。为了明确起见，
您可以将第二种意思称为“阻塞线程”。

Tokio 的文档将始终使用“阻塞”的第二种含义。

要在 Tokio 中运行阻塞代码，请参阅 Tokio API 参考中的 [CPU 密集型任务和阻塞代码][api-blocking] 部分。

[api-blocking]: https://docs.rs/tokio/1/tokio/#cpu-bound-tasks-and-blocking-code

## 流 (Stream)

[`Stream`] 是 [`Iterator`] 的异步版本，并提供一个值流。它通常与 `while let` 循环一起使用，如下所示：

```rust
use tokio_stream::StreamExt; // 用于 next()

# async fn dox() {
# let mut stream = tokio_stream::empty::<()>();
while let Some(item) = stream.next().await {
    // 执行一些操作
}
# }
```

“流”这个词有时会令人困惑地被用来指代 [`AsyncRead`] 和 [`AsyncWrite`] trait。

Tokio 的流实用程序目前由 [`tokio-stream`] crate 提供。
一旦 `Stream` trait 在 std 中稳定下来，流实用程序将被移到 `tokio` crate 中。

[`Stream`]: https://docs.rs/tokio-stream/0.1/tokio/trait.Stream.html
[`tokio-stream`]: https://docs.rs/tokio-stream
[`Iterator`]: https://doc.rust-lang.org/stable/std/iter/trait.Iterator.html
[`AsyncRead`]: https://docs.rs/tokio/1/tokio/io/trait.AsyncRead.html
[`AsyncWrite`]: https://docs.rs/tokio/1/tokio/io/trait.AsyncWrite.html

## 通道 (Channel)

通道是一种允许代码的一部分向其他部分发送消息的工具。
Tokio 提供了[多种通道][channels]，每种通道都有不同的用途。

- [mpsc]: 多生产者，单消费者通道。可以发送多个值。
- [oneshot]: 单生产者，单消费者通道。只能发送一个值。
- [broadcast]: 多生产者，多消费者。可以发送多个值。每个接收者都能看到每个值。
- [watch]: 单生产者，多消费者。可以发送多个值，但不保留历史记录。接收者只能看到最新的值。

如果您需要一个多生产者多消费者通道，并且每个消息只有一个消费者能看到，您可以使用 [`async-channel`] crate。

还有一些用于异步 Rust 之外的通道，例如 [`std::sync::mpsc`] 和 [`crossbeam::channel`]。
这些通道通过阻塞线程来等待消息，这在异步代码中是不允许的。

[channels]: https://docs.rs/tokio/1/tokio/sync/index.html
[mpsc]: https://docs.rs/tokio/1/tokio/sync/mpsc/index.html
[oneshot]: https://docs.rs/tokio/1/tokio/sync/oneshot/index.html
[broadcast]: https://docs.rs/tokio/1/tokio/sync/broadcast/index.html
[watch]: https://docs.rs/tokio/1/tokio/sync/watch/index.html
[`async-channel`]: https://docs.rs/async-channel/
[`std::sync::mpsc`]: https://doc.rust-lang.org/stable/std/sync/mpsc/index.html
[`crossbeam::channel`]: https://docs.rs/crossbeam/latest/crossbeam/channel/index.html

## 背压 (Backpressure)

背压是一种设计应用程序的模式，使其能够很好地应对高负载。
例如，`mpsc` 通道有有界和无界两种形式。通过使用有界通道，如果接收者跟不上消息的数量，
接收者可以对发送者施加“背压”，从而避免随着越来越多的消息在通道上发送而导致内存使用无限增长。

## 参与者 (Actor)

一种设计应用程序的模式。参与者指的是一个独立生成的任务，它代表应用程序的其他部分管理某些资源，
并使用通道与应用程序的其他部分进行通信。

有关参与者的示例，请参阅[通道章节]。

[the channels chapter]: /tokio/tutorial/channels
