---
title: "优雅关闭"
---

本页的目的是概述如何在异步应用程序中正确实现关闭。

实现优雅关闭通常包括三个部分：

- 确定何时关闭。
- 通知程序的每个部分进行关闭。
- 等待程序的其他部分完成关闭。

本文的其余部分将详细介绍这些部分。此处描述的方法的真实世界实现可以在 [mini-redis] 中找到，
特别是 [`src/server.rs`][server.rs] 和 [`src/shutdown.rs`][shutdown.rs] 文件。

## 确定何时关闭

这当然取决于应用程序，但一个非常常见的关闭标准是当应用程序收到来自操作系统的信号时。
例如，当程序在终端中运行时，您按下了 ctrl+c 就会发生这种情况。为了检测这一点，Tokio 提供了一个
[`tokio::signal::ctrl_c`][ctrl_c] 函数，该函数将休眠直到收到这样的信号。您可以这样使用它：

```rs
use tokio::signal;

#[tokio::main]
async fn main() {
    // ... 将应用程序生成为单独的任务 ...

    match signal::ctrl_c().await {
        Ok(()) => {},
        Err(err) => {
            eprintln!("无法监听关闭信号: {}", err);
            // 如果出错，我们也关闭
        },
    }

    // 向应用程序发送关闭信号并等待
}
```

如果您有多个关闭条件，您可以使用 [mpsc 通道][mpsc] 将关闭信号发送到一个地方。
然后，您可以在 [`ctrl_c`][ctrl_c] 和该通道上使用 [select]。例如：

```rs
use tokio::signal;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    let (shutdown_send, mut shutdown_recv) = mpsc::unbounded_channel();

    // ... 将应用程序生成为单独的任务 ...
    //
    // 如果从应用程序内部发出关闭，应用程序会使用 shutdown_send

    tokio::select! {
        _ = signal::ctrl_c() => {},
        _ = shutdown_recv.recv() => {},
    }

    // 向应用程序发送关闭信号并等待
}
```

## 通知任务进行关闭

当您想告诉一个或多个任务关闭时，您可以使用 [取消令牌 (Cancellation Tokens)][cancellation-tokens]。
这些令牌允许您通知任务它们应根据取消请求自行终止，从而轻松实现优雅关闭。

要在多个任务之间共享 `CancellationToken`，您必须克隆它。这是由于单一所有权规则要求每个值只有一个所有者。
当克隆令牌时，您会得到另一个与原始令牌无法区分的令牌；如果一个被取消，那么另一个也被取消。
您可以根据需要创建任意数量的克隆，并且当您在其中一个上调用 `cancel` 时，它们都会被取消。

以下是在多个任务中使用 `CancellationToken` 的步骤：

1. 首先，创建一个新的 `CancellationToken`。
2. 然后，通过调用原始令牌上的 `clone` 方法创建原始 `CancellationToken` 的克隆。这将创建一个可供其他任务使用的新令牌。
3. 将原始令牌或克隆令牌传递给应该响应取消请求的任务。
4. 当您想优雅地关闭任务时，在原始令牌或克隆令牌上调用 `cancel` 方法。任何在原始令牌或克隆令牌上监听取消请求的任务都将收到关闭通知。

以下是展示上述步骤的代码片段：

```rs
// 步骤 1：创建一个新的 CancellationToken
let token = CancellationToken::new();

// 步骤 2：克隆令牌以供另一个任务使用
let cloned_token = token.clone();

// 任务 1 - 等待令牌取消或很长时间
let task1_handle = tokio::spawn(async move {
    tokio::select! {
        // 步骤 3：使用克隆的令牌来监听取消请求
        _ = cloned_token.cancelled() => {
            // 令牌已被取消，任务可以关闭
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(9999)) => {
            // 长时间的工作已完成
        }
    }
});

// 任务 2 - 在短暂延迟后取消原始令牌
tokio::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // 步骤 4：取消原始或克隆的令牌，以通知其他任务优雅地关闭
    token.cancel();
});

// 等待任务完成
task1_handle.await.unwrap()
```

使用取消令牌，您不必在令牌被取消时立即关闭任务。相反，您可以在终止任务之前运行关闭程序，
例如将数据刷新到文件或数据库，或者在连接上发送关闭消息。

## 等待事物完成关闭

一旦您通知其他任务关闭，您将需要等待它们完成。一个简单的方法是使用 [任务跟踪器 (task tracker)]。
任务跟踪器是任务的集合。任务跟踪器的 [`wait`] 方法为您提供一个 future，
该 future 仅在其包含的所有 future 都已解析 **并且** 任务跟踪器已关闭后才会解析。

以下示例将生成 10 个任务，然后使用任务跟踪器等待它们关闭。

```rs
use std::time::Duration;
use tokio::time::sleep;
use tokio_util::task::TaskTracker;

#[tokio::main]
async fn main() {
    let tracker = TaskTracker::new();

    for i in 0..10 {
        tracker.spawn(some_operation(i));
    }

    // 一旦我们生成了所有任务，我们就关闭跟踪器。
    tracker.close();

    // 等待一切完成。
    tracker.wait().await;

    println!("This is printed after all of the tasks.");
}

async fn some_operation(i: u64) {
    sleep(Duration::from_millis(100 * i)).await;
    println!("Task {} shutting down.", i);
}
```

[ctrl_c]: https://docs.rs/tokio/1/tokio/signal/fn.ctrl_c.html
[task tracker]: https://docs.rs/tokio-util/latest/tokio_util/task/task_tracker
[`wait`]: https://docs.rs/tokio-util/latest/tokio_util/task/task_tracker/struct.TaskTracker.html#method.wait
[select]: https://docs.rs/tokio/1/tokio/macro.select.html
[cancellation-tokens]: https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html
[shutdown.rs]: https://github.com/tokio-rs/mini-redis/blob/master/src/shutdown.rs
[server.rs]: https://github.com/tokio-rs/mini-redis/blob/master/src/server.rs
[mini-redis]: https://github.com/tokio-rs/mini-redis/
[mpsc]: https://docs.rs/tokio/1/tokio/sync/mpsc/index.html
