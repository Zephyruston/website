---
title: "深入异步 (Async in depth)"
---

至此，我们已经完成了对异步 Rust 和 Tokio 相当全面的介绍。现在我们将更深入地研究 Rust 的异步运行时模型。在本教程的开头，我们曾暗示异步 Rust 采用了一种独特的方法。现在，我们将解释这意味着什么。

# Future (Futures)

作为快速回顾，让我们看一个非常基本的异步函数。这与本教程到目前为止介绍的内容相比没有什么新东西。

```rust
use tokio::net::TcpStream;

async fn my_async_fn() {
    println!("hello from async");
    let _socket = TcpStream::connect("127.0.0.1:3000").await.unwrap();
    println!("async TCP operation complete");
}
```

我们调用该函数，它会返回某个值。我们对该值调用 `.await`。

```rust
# async fn my_async_fn() {}
#[tokio::main]
async fn main() {
    let what_is_this = my_async_fn();
    // 尚未打印任何内容。
    what_is_this.await;
    // 文本已打印，并且套接字已
    // 建立和关闭。
}
```

`my_async_fn()` 返回的值是一个 future。Future 是一个实现了标准库提供的 [`std::future::Future`][trait] trait 的值。它们是包含正在进行的异步计算的值。

[`std::future::Future`][trait] trait 的定义是：

```rust
use std::pin::Pin;
use std::task::{Context, Poll};

pub trait Future {
    type Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context)
        -> Poll<Self::Output>;
}
```

[关联类型][assoc] `Output` 是 future 完成后产生的类型。[`Pin`][pin] 类型是 Rust 如何能够在 `async` 函数中支持借用的。有关更多详细信息，请参阅[标准库][pin]文档。

与其他语言中 future 的实现方式不同，Rust future 并不代表在后台发生的计算，而是 Rust future **本身**就是计算。Future 的所有者负责通过轮询 future 来推进计算。这是通过调用 `Future::poll` 完成的。

## 实现 `Future` (Implementing `Future`)

让我们实现一个非常简单的 future。这个 future 将：

1. 等待直到一个特定的时间点。
2. 将一些文本输出到 STDOUT。
3. 产生一个字符串。

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

struct Delay {
    when: Instant,
}

impl Future for Delay {
    type Output = &'static str;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>)
        -> Poll<&'static str>
    {
        if Instant::now() >= self.when {
            println!("Hello world");
            Poll::Ready("done")
        } else {
            // 现在请忽略这一行。
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

#[tokio::main]
async fn main() {
    let when = Instant::now() + Duration::from_millis(10);
    let future = Delay { when };

    let out = future.await;
    assert_eq!(out, "done");
}
```

## Async fn 作为 Future (Async fn as a Future)

在主函数中，我们实例化了这个 future 并对其调用了 `.await`。在异步函数中，我们可以对任何实现了 `Future` 的值调用 `.await`。反过来，调用一个 `async` 函数会返回一个实现了 `Future` 的匿名类型。在 `async fn main()` 的情况下，生成的 future 大致如下：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

enum MainFuture {
    // 已初始化，从未被轮询
    State0,
    // 正在等待 `Delay`，即 `future.await` 这一行。
    State1(Delay),
    // Future 已完成。
    Terminated,
}
# struct Delay { when: Instant };
# impl Future for Delay {
#     type Output = &'static str;
#     fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<&'static str> {
#         unimplemented!();
#     }
# }

impl Future for MainFuture {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>)
        -> Poll<()>
    {
        use MainFuture::*;

        loop {
            match *self {
                State0 => {
                    let when = Instant::now() +
                        Duration::from_millis(10);
                    let future = Delay { when };
                    *self = State1(future);
                }
                State1(ref mut my_future) => {
                    match Pin::new(my_future).poll(cx) {
                        Poll::Ready(out) => {
                            assert_eq!(out, "done");
                            *self = Terminated;
                            return Poll::Ready(());
                        }
                        Poll::Pending => {
                            return Poll::Pending;
                        }
                    }
                }
                Terminated => {
                    panic!("future polled after completion")
                }
            }
        }
    }
}
```

Rust future 是**状态机**。这里，`MainFuture` 被表示为一个包含 future 可能状态的 `enum`。Future 从 `State0` 状态开始。当调用 `poll` 时，Future 会尝试尽可能多地推进其内部状态。如果 Future 能够完成，则返回包含异步计算输出的 `Poll::Ready`。

如果 Future **未**能完成，通常是由于它正在等待的资源尚未就绪，则返回 `Poll::Pending`。接收到 `Poll::Pending` 表示调用者 Future 将在稍后完成，并且调用者应该稍后再次调用 `poll`。

我们还看到 Future 是由其他 Future 组成的。对外部 Future 调用 `poll` 会导致调用内部 Future 的 `poll` 函数。

# 执行器 (Executors)

异步 Rust 函数返回 Future。Future 必须对其调用 `poll` 才能推进其状态。Future 是由其他 Future 组成的。那么，问题来了，什么是对最外层的 Future 调用 `poll` 的呢？

回想一下，要运行异步函数，必须将它们传递给 `tokio::spawn` 或者是使用 `#[tokio::main]` 注解的主函数。这会将生成的最外层 Future 提交给 Tokio 执行器。执行器负责调用最外层 Future 的 `Future::poll`，驱动异步计算完成。

## Mini Tokio

为了更好地理解这一切是如何组合在一起的，让我们实现我们自己的 Tokio 精简版！完整代码可以在[这里][mini-tokio]找到。

```rust
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use futures::task;

fn main() {
    let mut mini_tokio = MiniTokio::new();

    mini_tokio.spawn(async {
        let when = Instant::now() + Duration::from_millis(10);
        let future = Delay { when };

        let out = future.await;
        assert_eq!(out, "done");
    });

    mini_tokio.run();
}
# struct Delay { when: Instant }
# impl Future for Delay {
#     type Output = &'static str;
#     fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<&'static str> {
#         Poll::Ready("done")
#     }
# }

struct MiniTokio {
    tasks: VecDeque<Task>,
}

type Task = Pin<Box<dyn Future<Output = ()> + Send>>;

impl MiniTokio {
    fn new() -> MiniTokio {
        MiniTokio {
            tasks: VecDeque::new(),
        }
    }

    /// 将一个 future 生成到 mini-tokio 实例上。
    fn spawn<F>(&mut self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.tasks.push_back(Box::pin(future));
    }

    fn run(&mut self) {
        let waker = task::noop_waker();
        let mut cx = Context::from_waker(&waker);

        while let Some(mut task) = self.tasks.pop_front() {
            if task.as_mut().poll(&mut cx).is_pending() {
                self.tasks.push_back(task);
            }
        }
    }
}
```

这会运行异步代码块。创建一个具有请求延迟的 `Delay` 实例并对其进行等待。然而，我们目前的实现有一个主要的**缺陷**。我们的执行器永远不会休眠。执行器不断地循环**所有**已生成的 Future 并轮询它们。大多数情况下，Future 将没有准备好执行更多工作，并将再次返回 `Poll::Pending`。该进程将消耗 CPU 周期，并且通常效率不高。

理想情况下，我们希望 mini-tokio 仅在 Future 能够取得进展时才轮询它们。当任务被阻塞的资源准备好执行请求的操作时，就会发生这种情况。如果任务想从 TCP 套接字读取数据，那么我们只想在 TCP 套接字接收到数据时才轮询该任务。在我们的例子中，任务被阻塞，直到达到给定的 `Instant`。理想情况下，mini-tokio 只会在那个时间点过去之后才轮询任务。

为了实现这一点，当轮询一个资源并且该资源**未**就绪时，该资源会在转换到就绪状态后发送一个通知。

# 唤醒器 (Wakers)

唤醒器是缺失的部分。这是资源能够通知等待任务，告知资源已准备好继续某些操作的机制。

让我们再看一下 `Future::poll` 的定义：

```rust,compile_fail
fn poll(self: Pin<&mut Self>, cx: &mut Context)
    -> Poll<Self::Output>;
```

`poll` 的 `Context` 参数有一个 `waker()` 方法。此方法返回一个绑定到当前任务的 [`Waker`]。[`Waker`] 有一个 `wake()` 方法。调用此方法会向执行器发出信号，指示关联的任务应该被调度执行。当资源转换到就绪状态时，它们会调用 `wake()`，以通知执行器轮询任务将能够取得进展。

## 更新 `Delay` (Updating `Delay`)

我们可以更新 `Delay` 以使用唤醒器：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use std::thread;

struct Delay {
    when: Instant,
}

impl Future for Delay {
    type Output = &'static str;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>)
        -> Poll<&'static str>
    {
        if Instant::now() >= self.when {
            println!("Hello world");
            Poll::Ready("done")
        } else {
            // 获取当前任务的唤醒器句柄
            let waker = cx.waker().clone();
            let when = self.when;

            // 生成一个计时器线程。
            thread::spawn(move || {
                let now = Instant::now();

                if now < when {
                    thread::sleep(when - now);
                }

                waker.wake();
            });

            Poll::Pending
        }
    }
}
```

现在，一旦请求的持续时间过去，调用任务就会收到通知，并且执行器可以确保任务被再次调度。下一步是更新 mini-tokio 以侦听唤醒通知。

我们的 `Delay` 实现仍然存在一些问题。我们稍后会修复它们。

> **警告**
> 当 Future 返回 `Poll::Pending` 时，它**必须**确保唤醒器在某个时间点被触发。忘记这样做会导致任务无限期挂起。
>
> 在返回 `Poll::Pending` 后忘记唤醒任务是常见的错误来源。

回想一下 `Delay` 的第一次迭代。这是 Future 的实现：

```rust
# use std::future::Future;
# use std::pin::Pin;
# use std::task::{Context, Poll};
# use std::time::Instant;
# struct Delay { when: Instant }
impl Future for Delay {
    type Output = &'static str;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>)
        -> Poll<&'static str>
    {
        if Instant::now() >= self.when {
            println!("Hello world");
            Poll::Ready("done")
        } else {
            // 现在请忽略这一行。
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}
```

在返回 `Poll::Pending` 之前，我们调用了 `cx.waker().wake_by_ref()`。这是为了满足 Future 的约定。通过返回 `Poll::Pending`，我们负责发出唤醒器信号。因为我们还没有实现计时器线程，所以我们内联地发出了唤醒器信号。这样做会导致 Future 立即被重新调度、再次执行，并且可能仍然没有准备好完成。

请注意，允许比必要更频繁地发出唤醒器信号。在这种特定情况下，即使我们根本没有准备好继续操作，我们也发出了唤醒器信号。除了浪费一些 CPU 周期外，这没有任何问题。然而，这个特定的实现将导致一个忙循环 (busy loop)。

## 更新 Mini Tokio (Updating Mini Tokio)

下一步是更新 Mini Tokio 以接收唤醒器通知。我们希望执行器仅在任务被唤醒时才运行任务，为此，Mini Tokio 将提供自己的唤醒器。当唤醒器被调用时，其关联的任务将被排队等待执行。Mini-Tokio 在轮询 Future 时将此唤醒器传递给 Future。

更新后的 Mini Tokio 将使用通道来存储已调度的任务。通道允许任务从任何线程排队等待执行。唤醒器必须是 `Send` 和 `Sync` 的。

> **信息** > `Send` 和 `Sync` trait 是 Rust 提供的与并发相关的标记 trait。可以**发送 (sent)**到不同线程的类型是 `Send`。大多数类型是 `Send`，但像 [`Rc`] 这样的类型则不是。可以通过不可变引用**并发 (concurrently)**访问的类型是 `Sync`。一个类型可以是 `Send` 但不是 `Sync` —— 一个很好的例子是 [`Cell`]，它可以通过不可变引用进行修改，因此并发访问是不安全的。
>
> 更多详细信息，请参阅 Rust 书中相关的[章节][ch]。

[`Rc`]: https://doc.rust-lang.org/std/rc/struct.Rc.html
[`Cell`]: https://doc.rust-lang.org/std/cell/struct.Cell.html
[ch]: https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html

更新 `MiniTokio` 结构体。

```rust
use std::sync::mpsc;
use std::sync::Arc;

struct MiniTokio {
    scheduled: mpsc::Receiver<Arc<Task>>,
    sender: mpsc::Sender<Arc<Task>>,
}

struct Task {
    // 这部分很快就会填充。
}
```

唤醒器是 `Sync` 的并且可以被克隆。当调用 `wake` 时，任务必须被调度执行。为了实现这一点，我们使用了一个通道。当对唤醒器调用 `wake()` 时，任务会被推入通道的发送端。我们的 `Task` 结构体将实现唤醒逻辑。为此，它需要包含生成的 future 和通道的发送端。我们将 future 放在一个 `TaskFuture` 结构体中，旁边是一个 `Poll` 枚举，用于跟踪最新的 `Future::poll()` 结果，这是处理伪唤醒 (spurious wake-ups) 所必需的。更多细节在 `TaskFuture` 的 `poll()` 方法实现中给出。

```rust
# use std::future::Future;
# use std::pin::Pin;
# use std::sync::mpsc;
# use std::task::Poll;
use std::sync::{Arc, Mutex};

/// 一个结构体，包含一个 future 以及对其 `poll` 方法
/// 最新调用结果的跟踪。
struct TaskFuture {
    future: Pin<Box<dyn Future<Output = ()> + Send>>,
    poll: Poll<()>,
}

struct Task {
    // `Mutex` 是为了使 `Task` 实现 `Sync`。在任何给定时间，
    // 只有一个线程访问 `task_future`。
    // `Mutex` 对于正确性来说不是必需的。真正的 Tokio
    // 在这里不使用互斥锁，但真正的 Tokio 有
    // 比单个教程页面所能容纳的更多的代码行。
    task_future: Mutex<TaskFuture>,
    executor: mpsc::Sender<Arc<Task>>,
}

impl Task {
    fn schedule(self: &Arc<Self>) {
        self.executor.send(self.clone());
    }
}
```

为了调度任务，`Arc` 被克隆并通过通道发送。现在，我们需要将我们的 `schedule` 函数与 [`std::task::Waker`][`Waker`] 挂钩。标准库提供了一个低级 API 来使用[手动 vtable 构造][vtable]来实现这一点。这种策略为实现者提供了最大的灵活性，但需要一堆不安全的样板代码。我们不直接使用 [`RawWakerVTable`][vtable]，而是使用 [`futures`] crate 提供的 [`ArcWake`] 工具。这允许我们实现一个简单的 trait，将我们的 `Task` 结构体作为唤醒器暴露出来。

将以下依赖项添加到你的 `Cargo.toml` 以引入 `futures`。

```toml
futures = "0.3"
```

然后实现 [`futures::task::ArcWake`][`ArcWake`]。

```rust
use futures::task::{self, ArcWake};
use std::sync::Arc;
# struct Task {}
# impl Task {
#     fn schedule(self: &Arc<Self>) {}
# }
impl ArcWake for Task {
    fn wake_by_ref(arc_self: &Arc<Self>) {
        arc_self.schedule();
    }
}
```

当上面的计时器线程调用 `waker.wake()` 时，任务被推入通道。接下来，我们在 `MiniTokio::run()` 函数中实现接收和执行任务。

```rust
# use std::sync::mpsc;
# use futures::task::{self, ArcWake};
# use std::future::Future;
# use std::pin::Pin;
# use std::sync::{Arc, Mutex};
# use std::task::{Context, Poll};
# struct MiniTokio {
#   scheduled: mpsc::Receiver<Arc<Task>>,
#   sender: mpsc::Sender<Arc<Task>>,
# }
# struct TaskFuture {
#     future: Pin<Box<dyn Future<Output = ()> + Send>>,
#     poll: Poll<()>,
# }
# struct Task {
#   task_future: Mutex<TaskFuture>,
#   executor: mpsc::Sender<Arc<Task>>,
# }
# impl ArcWake for Task {
#   fn wake_by_ref(arc_self: &Arc<Self>) {}
# }
impl MiniTokio {
    fn run(&self) {
        while let Ok(task) = self.scheduled.recv() {
            task.poll();
        }
    }

    /// 初始化一个新的 mini-tokio 实例。
    fn new() -> MiniTokio {
        let (sender, scheduled) = mpsc::channel();

        MiniTokio { scheduled, sender }
    }

    /// 将一个 future 生成到 mini-tokio 实例上。
    ///
    /// 给定的 future 被包装在 `Task` 工具中，并被推入
    /// `scheduled` 队列。当调用 `run` 时，该 future 将被执行。
    fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        Task::spawn(future, &self.sender);
    }
}

impl TaskFuture {
    fn new(future: impl Future<Output = ()> + Send + 'static) -> TaskFuture {
        TaskFuture {
            future: Box::pin(future),
            poll: Poll::Pending,
        }
    }

    fn poll(&mut self, cx: &mut Context<'_>) {
        // 即使 future 已经返回 `Ready`，也允许伪唤醒。
        // 但是，*不允许*轮询一个已经返回 `Ready` 的 future。
        // 因此，我们需要在调用它之前检查 future 是否仍然处于挂起状态。
        // 如果不这样做，可能会导致 panic。
        if self.poll.is_pending() {
            self.poll = self.future.as_mut().poll(cx);
        }
    }
}

impl Task {
    fn poll(self: Arc<Self>) {
        // 从 `Task` 实例创建一个唤醒器。这使用了上面的 `ArcWake` 实现。
        let waker = task::waker(self.clone());
        let mut cx = Context::from_waker(&waker);

        // 没有其他线程尝试锁定 task_future
        let mut task_future = self.task_future.try_lock().unwrap();

        // 轮询内部的 future
        task_future.poll(&mut cx);
    }

    // 用给定的 future 生成一个新任务。
    //
    // 初始化一个新的 Task 工具，其中包含给定的 future，并将其推送到
    // `sender` 上。通道的接收端将获取任务并执行它。
    fn spawn<F>(future: F, sender: &mpsc::Sender<Arc<Task>>)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let task = Arc::new(Task {
            task_future: Mutex::new(TaskFuture::new(future)),
            executor: sender.clone(),
        });

        let _ = sender.send(task);
    }
}
```

这里发生了几件事。首先，实现了 `MiniTokio::run()`。该函数在一个循环中运行，从通道接收已调度的任务。当任务在它们被唤醒时被推入通道，这些任务在执行时能够取得进展。

此外，`MiniTokio::new()` 和 `MiniTokio::spawn()` 函数被调整为使用通道而不是 `VecDeque`。当生成新任务时，它们会获得通道发送端部分的克隆，任务可以使用它将自己调度到运行时上。

`Task::poll()` 函数使用 `futures` crate 中的 [`ArcWake`] 工具创建唤醒器。唤醒器用于创建 `task::Context`。该 `task::Context` 被传递给 `poll`。

# 总结 (Summary)

我们现在已经看到了一个关于异步 Rust 如何工作的端到端示例。Rust 的 `async/await` 功能由 traits 提供支持。这允许像 Tokio 这样的第三方 crate 提供执行细节。

- 异步 Rust 操作是惰性的，需要调用者来轮询它们。
- 唤醒器被传递给 Future，以将 Future 与调用它的任务链接起来。
- 当资源**未**准备好完成操作时，会返回 `Poll::Pending`，并记录任务的唤醒器。
- 当资源就绪时，会通知任务的唤醒器。
- 执行器收到通知并调度任务执行。
- 任务再次被轮询，此时资源已就绪，任务取得进展。

# 一些未完成的细节 (A few loose ends)

回想一下，当我们实现 `Delay` future 时，我们说过还有一些事情需要修复。Rust 的异步模型允许单个 Future 在执行过程中跨任务迁移。考虑以下情况：

```rust
use futures::future::poll_fn;
use std::future::Future;
use std::pin::Pin;
# use std::task::{Context, Poll};
# use std::time::{Duration, Instant};
# struct Delay { when: Instant }
# impl Future for Delay {
#   type Output = ();
#   fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
#       Poll::Pending
#   }
# }

#[tokio::main]
async fn main() {
    let when = Instant::now() + Duration::from_millis(10);
    let mut delay = Some(Delay { when });

    poll_fn(move |cx| {
        let mut delay = delay.take().unwrap();
        let res = Pin::new(&mut delay).poll(cx);
        assert!(res.is_pending());
        tokio::spawn(async move {
            delay.await;
        });

        Poll::Ready(())
    }).await;
}
```

`poll_fn` 函数使用闭包创建一个 `Future` 实例。上面的代码片段创建了一个 `Delay` 实例，轮询它一次，然后将 `Delay` 实例发送到一个新任务，在那里它被等待。在这个例子中，`Delay::poll` 被使用**不同**的 `Waker` 实例调用了不止一次。当发生这种情况时，你必须确保对*最近一次* `poll` 调用时传入的 `Waker` 调用 `wake`。

在实现 Future 时，关键是要假设每次调用 `poll` **都可能**提供一个不同的 `Waker` 实例。poll 函数必须用新的唤醒器更新任何先前记录的唤醒器。

我们之前实现的 `Delay` 在每次被轮询时都会生成一个新线程。这没问题，但如果它被过于频繁地轮询（例如，如果你在该 Future 和其他 Future 之间使用 `select!`，只要其中一个有事件，两者都会被轮询），这可能会非常低效。解决这个问题的一个方法是记住你是否已经生成了一个线程，并且只有在你还没有生成线程的情况下才生成一个新线程。但是，如果你这样做，你必须确保在线程的 `Waker` 在后续调用 poll 时被更新，因为否则你不会唤醒最新的 `Waker`。

为了修复我们之前的实现，我们可以这样做：

```rust
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread;
use std::time::{Duration, Instant};

struct Delay {
    when: Instant,
    // 当我们生成了一个线程时，这是 Some，否则为 None。
    waker: Option<Arc<Mutex<Waker>>>,
}

impl Future for Delay {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        // 检查当前时刻。如果持续时间已过，那么
        // 这个 future 已经完成，所以我们返回 `Poll::Ready`。
        if Instant::now() >= self.when {
            return Poll::Ready(());
        }

        // 持续时间尚未过去。如果这是第一次调用该 future，
        // 则生成计时器线程。如果计时器线程已经在运行，
        // 确保存储的 `Waker` 与当前任务的唤醒器匹配。
        if let Some(waker) = &self.waker {
            let mut waker = waker.lock().unwrap();

            // 检查存储的唤醒器是否与当前任务的唤醒器匹配。
            // 这是必要的，因为 `Delay` future 实例可能会在
            // 对 `poll` 的调用之间移动到不同的任务。如果发生这种情况，
            // 给定 `Context` 中包含的唤醒器将有所不同，并且
            // 我们必须更新我们存储的唤醒器以反映此变化。
            if !waker.will_wake(cx.waker()) {
                *waker = cx.waker().clone();
            }
        } else {
            let when = self.when;
            let waker = Arc::new(Mutex::new(cx.waker().clone()));
            self.waker = Some(waker.clone());

            // 这是第一次调用 `poll`，生成计时器线程。
            thread::spawn(move || {
                let now = Instant::now();

                if now < when {
                    thread::sleep(when - now);
                }

                // 持续时间已过。通过调用唤醒器来通知调用者。
                let waker = waker.lock().unwrap();
                waker.wake_by_ref();
            });
        }

        // 到目前为止，唤醒器已被存储，计时器线程也已启动。
        // 持续时间尚未过去（回想一下，我们首先检查了这一点），
        // 因此 future 尚未完成，所以我们必须返回 `Poll::Pending`。
        //
        // `Future` trait 约定要求，当返回 `Pending` 时，
        // future 必须确保一旦应该再次轮询 future，给定的唤醒器就会被触发。
        // 在我们的例子中，通过在这里返回 `Pending`，我们承诺
        // 一旦请求的持续时间过去，我们将调用 `Context` 参数中包含的
        // 给定的唤醒器。我们通过生成上面的计时器线程来确保这一点。
        //
        // 如果我们忘记调用唤醒器，任务将无限期挂起。
        Poll::Pending
    }
}
```

这有点复杂，但想法是，在每次调用 `poll` 时，Future 会检查提供的唤醒器是否与先前记录的唤醒器匹配。如果两个唤醒器匹配，则无需执行任何其他操作。如果它们不匹配，则必须更新记录的唤醒器。

## `Notify` 工具 (`Notify` utility)

我们演示了如何使用唤醒器手动实现 `Delay` future。唤醒器是异步 Rust 工作原理的基础。通常，没有必要降低到那个级别。例如，在 `Delay` 的情况下，我们可以使用 [`tokio::sync::Notify`][notify] 工具完全用 `async/await` 来实现它。此工具提供了基本的任务通知机制。它处理唤醒器的细节，包括确保记录的唤醒器与当前任务匹配。

使用 [`Notify`][notify]，我们可以像这样使用 `async/await` 实现一个 `delay` 函数：

```rust
use tokio::sync::Notify;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::thread;

async fn delay(dur: Duration) {
    let when = Instant::now() + dur;
    let notify = Arc::new(Notify::new());
    let notify_clone = notify.clone();

    thread::spawn(move || {
        let now = Instant::now();

        if now < when {
            thread::sleep(when - now);
        }

        notify_clone.notify_one();
    });


    notify.notified().await;
}
```

[assoc]: https://doc.rust-lang.org/book/ch19-03-advanced-traits.html#specifying-placeholder-types-in-trait-definitions-with-associated-types
[trait]: https://doc.rust-lang.org/std/future/trait.Future.html
[pin]: https://doc.rust-lang.org/std/pin/index.html
[`Waker`]: https://doc.rust-lang.org/std/task/struct.Waker.html
[mini-tokio]: https://github.com/tokio-rs/website/blob/master/tutorial-code/mini-tokio/src/main.rs
[vtable]: https://doc.rust-lang.org/std/task/struct.RawWakerVTable.html
[`ArcWake`]: https://docs.rs/futures/0.3/futures/task/trait.ArcWake.html
[`futures`]: https://docs.rs/futures/
[notify]: https://docs.rs/tokio/1/tokio/sync/struct.Notify.html
