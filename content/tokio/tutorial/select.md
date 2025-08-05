---
title: "选择 (Select)"
---

到目前为止，当我们想在系统中添加并发时，我们会生成一个新任务。
现在我们将介绍一些使用 Tokio 并发执行异步代码的其他方法。

# `tokio::select!`

`tokio::select!` 宏允许等待多个异步计算，并在**单个**计算完成时返回。

例如：

```rust
use tokio::sync::oneshot;

#[tokio::main]
async fn main() {
    let (tx1, rx1) = oneshot::channel();
    let (tx2, rx2) = oneshot::channel();

    tokio::spawn(async {
        let _ = tx1.send("one");
    });

    tokio::spawn(async {
        let _ = tx2.send("two");
    });

    tokio::select! {
        val = rx1 => {
            println!("rx1 completed first with {:?}", val);
        }
        val = rx2 => {
            println!("rx2 completed first with {:?}", val);
        }
    }
}
```

这里使用了两个 oneshot 通道。任一通道都可能先完成。`select!` 语句会等待这两个通道，并将 `val` 绑定到任务返回的值。当 `tx1` 或 `tx2` 完成时，相关的代码块就会执行。

**未**完成的分支将被丢弃。在此示例中，计算正在等待每个通道的 `oneshot::Receiver`。尚未完成的那个通道的 `oneshot::Receiver` 将被丢弃。

## 取消 (Cancellation)

在异步 Rust 中，取消是通过丢弃 future 来执行的。回想一下[“深入异步 (Async in depth)”][async]中的内容，异步 Rust 操作是使用 future 实现的，并且 future 是惰性的。只有当 future 被轮询时，操作才会继续进行。如果 future 被丢弃，操作就无法继续，因为所有相关的状态都已被丢弃。

也就是说，有时异步操作会生成后台任务或启动其他在后台运行的操作。例如，在上面的示例中，生成了一个任务来回送消息。通常，该任务会执行一些计算来生成值。

Future 或其他类型可以实现 `Drop` 来清理后台资源。Tokio 的 `oneshot::Receiver` 通过向 `Sender` 半部分发送一个关闭通知来实现 `Drop`。发送者半部分可以接收此通知，并通过丢弃它来中止正在进行的操作。

```rust
use tokio::sync::oneshot;

async fn some_operation() -> String {
    // 在此处计算值
# "wut".to_string()
}

#[tokio::main]
async fn main() {
    let (mut tx1, rx1) = oneshot::channel();
    let (tx2, rx2) = oneshot::channel();

    tokio::spawn(async {
        // 在操作和 oneshot 的
        // `closed()` 通知之间进行选择。
        tokio::select! {
            val = some_operation() => {
                let _ = tx1.send(val);
            }
            _ = tx1.closed() => {
                // `some_operation()` 被取消，
                // 任务完成，`tx1` 被丢弃。
            }
        }
    });

    tokio::spawn(async {
        let _ = tx2.send("two");
    });

    tokio::select! {
        val = rx1 => {
            println!("rx1 completed first with {:?}", val);
        }
        val = rx2 => {
            println!("rx2 completed first with {:?}", val);
        }
    }
}
```

[async]: async.md

## `Future` 实现 (The `Future` implementation)

为了帮助更好地理解 `select!` 的工作原理，让我们看一下假设的 `Future` 实现会是什么样子。这是一个简化版本。在实践中，`select!` 包含额外的功能，例如随机选择要首先轮询的分支。

```rust
use tokio::sync::oneshot;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

struct MySelect {
    rx1: oneshot::Receiver<&'static str>,
    rx2: oneshot::Receiver<&'static str>,
}

impl Future for MySelect {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if let Poll::Ready(val) = Pin::new(&mut self.rx1).poll(cx) {
            println!("rx1 completed first with {:?}", val);
            return Poll::Ready(());
        }

        if let Poll::Ready(val) = Pin::new(&mut self.rx2).poll(cx) {
            println!("rx2 completed first with {:?}", val);
            return Poll::Ready(());
        }

        Poll::Pending
    }
}

#[tokio::main]
async fn main() {
    let (tx1, rx1) = oneshot::channel();
    let (tx2, rx2) = oneshot::channel();

    // 使用 tx1 和 tx2
# tx1.send("one").unwrap();
# tx2.send("two").unwrap();

    MySelect {
        rx1,
        rx2,
    }.await;
}
```

`MySelect` future 包含来自每个分支的 future。当轮询 `MySelect` 时，首先轮询第一个分支。如果它就绪了，则使用该值，`MySelect` 完成。在 `.await` 接收到 future 的输出后，该 future 会被丢弃。这会导致两个分支的 future 都被丢弃。由于一个分支没有完成，该操作实际上被取消了。

请记住上一节中的内容：

> 当 future 返回 `Poll::Pending` 时，它**必须**确保唤醒器 (waker) 在未来的某个时刻被触发。忘记这样做会导致任务无限期挂起。

在 `MySelect` 实现中没有显式使用 `Context` 参数。相反，唤醒器要求是通过将 `cx` 传递给内部 future 来满足的。由于内部 future 也必须满足唤醒器要求，只有当从内部 future 接收到 `Poll::Pending` 时才返回 `Poll::Pending`，`MySelect` 也满足了唤醒器要求。

# 语法 (Syntax)

`select!` 宏可以处理两个以上的分支。目前的限制是 64 个分支。每个分支的结构如下：

```text
<pattern> = <async expression> => <handler>,
```

当 `select` 宏被求值时，所有的 `<async expression>` 都会被聚合并并发执行。当一个表达式完成时，其结果会与 `<pattern>` 进行匹配。如果结果与模式匹配，则所有剩余的异步表达式都将被丢弃，并执行 `<handler>`。`<handler>` 表达式可以访问由 `<pattern>` 建立的任何绑定。

`<pattern>` 的基本情况是一个变量名，异步表达式的结果将绑定到该变量名，并且 `<handler>` 可以访问该变量。这就是为什么在最初的示例中，`val` 被用作 `<pattern>`，而 `<handler>` 能够访问 `val`。

如果 `<pattern>` **不**匹配异步计算的结果，则剩余的异步表达式继续并发执行，直到下一个完成。此时，将相同的逻辑应用于该结果。

因为 `select!` 接受任何异步表达式，所以可以定义更复杂的计算来进行选择。

在这里，我们选择一个 `oneshot` 通道的输出和一个 TCP 连接。

```rust
use tokio::net::TcpStream;
use tokio::sync::oneshot;

#[tokio::main]
async fn main() {
    let (tx, rx) = oneshot::channel();

    // 生成一个通过 oneshot 发送消息的任务
    tokio::spawn(async move {
        tx.send("done").unwrap();
    });

    tokio::select! {
        socket = TcpStream::connect("localhost:3465") => {
            println!("Socket connected {:?}", socket);
        }
        msg = rx => {
            println!("received message first {:?}", msg);
        }
    }
}
```

在这里，我们选择一个 oneshot 和从 `TcpListener` 接受套接字。

```rust
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use std::io;

#[tokio::main]
async fn main() -> io::Result<()> {
    let (tx, rx) = oneshot::channel();

    tokio::spawn(async move {
        tx.send(()).unwrap();
    });

    let mut listener = TcpListener::bind("localhost:3465").await?;

    tokio::select! {
        _ = async {
            loop {
                let (socket, _) = listener.accept().await?;
                tokio::spawn(async move { process(socket) });
            }

            // 帮助 Rust 类型推断器
            Ok::<_, io::Error>(())
        } => {}
        _ = rx => {
            println!("terminating accept loop");
        }
    }

    Ok(())
}
# async fn process(_: tokio::net::TcpStream) {}
```

接受循环会一直运行，直到遇到错误或 `rx` 接收到一个值。`_` 模式表示我们对异步计算的返回值不感兴趣。

# 返回值 (Return value)

`tokio::select!` 宏返回被求值的 `<handler>` 表达式的结果。

```rust
async fn computation1() -> String {
    // .. 计算
# unimplemented!();
}

async fn computation2() -> String {
    // .. 计算
# unimplemented!();
}

# fn dox() {
#[tokio::main]
async fn main() {
    let out = tokio::select! {
        res1 = computation1() => res1,
        res2 = computation2() => res2,
    };

    println!("Got = {}", out);
}
# }
```

因此，要求**每个**分支的 `<handler>` 表达式求值为相同的类型。如果 `select!` 表达式的输出不需要，一个好的做法是让表达式求值为 `()`。

# 错误 (Errors)

使用 `?` 运算符会传播表达式中的错误。其工作原理取决于 `?` 是在异步表达式中还是在处理程序中使用。在异步表达式中使用 `?` 会将错误传播到该异步表达式之外。这使得异步表达式的输出成为一个 `Result`。在处理程序中使用 `?` 会立即将错误传播到 `select!` 表达式之外。让我们再看一下接受循环的例子：

```rust
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use std::io;

#[tokio::main]
async fn main() -> io::Result<()> {
    // [设置 `rx` oneshot 通道]
# let (tx, rx) = oneshot::channel();
# tx.send(()).unwrap();

    let listener = TcpListener::bind("localhost:3465").await?;

    tokio::select! {
        res = async {
            loop {
                let (socket, _) = listener.accept().await?;
                tokio::spawn(async move { process(socket) });
            }

            // 帮助 Rust 类型推断器
            Ok::<_, io::Error>(())
        } => {
            res?;
        }
        _ = rx => {
            println!("terminating accept loop");
        }
    }

    Ok(())
}
# async fn process(_: tokio::net::TcpStream) {}
```

注意 `listener.accept().await?`。`?` 运算符将错误从该表达式传播出去，并传播到 `res` 绑定。如果发生错误，`res` 将被设置为 `Err(_)`。然后，在处理程序中，再次使用了 `?` 运算符。`res?` 语句会将错误传播到 `main` 函数之外。

# 模式匹配 (Pattern matching)

回想一下，`select!` 宏分支语法定义为：

```text
<pattern> = <async expression> => <handler>,
```

到目前为止，我们只对 `<pattern>` 使用了变量绑定。但是，可以使用任何 Rust 模式。例如，假设我们正在从多个 MPSC 通道接收，我们可能会这样做：

```rust
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    let (mut tx1, mut rx1) = mpsc::channel(128);
    let (mut tx2, mut rx2) = mpsc::channel(128);

    tokio::spawn(async move {
        // 用 `tx1` 和 `tx2` 做点什么
# tx1.send(1).await.unwrap();
# tx2.send(2).await.unwrap();
    });

    tokio::select! {
        Some(v) = rx1.recv() => {
            println!("Got {:?} from rx1", v);
        }
        Some(v) = rx2.recv() => {
            println!("Got {:?} from rx2", v);
        }
        else => {
            println!("Both channels closed");
        }
    }
}
```

在此示例中，`select!` 表达式等待从 `rx1` 和 `rx2` 接收值。如果一个通道关闭，`recv()` 返回 `None`。这**不**匹配该模式，因此该分支被禁用。`select!` 表达式将继续等待剩余的分支。

请注意，这个 `select!` 表达式包含一个 `else` 分支。`select!` 表达式必须求值为一个值。当使用模式匹配时，可能**没有**分支匹配其关联的模式。如果发生这种情况，则求值 `else` 分支。

# 借用 (Borrowing)

当生成任务时，生成的异步表达式必须拥有其所有数据。`select!` 宏没有此限制。每个分支的异步表达式都可以借用数据并并发操作。遵循 Rust 的借用规则，多个异步表达式可以不可变地借用单份数据**或者**单个异步表达式可以可变地借用一份数据。

让我们看一些例子。在这里，我们同时将相同的数据发送到两个不同的 TCP 目标。

```rust
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use std::io;
use std::net::SocketAddr;

async fn race(
    data: &[u8],
    addr1: SocketAddr,
    addr2: SocketAddr
) -> io::Result<()> {
    tokio::select! {
        Ok(_) = async {
            let mut socket = TcpStream::connect(addr1).await?;
            socket.write_all(data).await?;
            Ok::<_, io::Error>(())
        } => {}
        Ok(_) = async {
            let mut socket = TcpStream::connect(addr2).await?;
            socket.write_all(data).await?;
            Ok::<_, io::Error>(())
        } => {}
        else => {}
    };

    Ok(())
}
# fn main() {}
```

`data` 变量正从两个异步表达式中**不可变地**借用。当其中一个操作成功完成时，另一个被丢弃。因为我们模式匹配 `Ok(_)`，如果一个表达式失败，另一个会继续执行。

当涉及到每个分支的 `<handler>` 时，`select!` 保证只运行单个 `<handler>`。因此，每个 `<handler>` 都可以可变地借用相同的数据。

例如，这会在两个处理程序中修改 `out`：

```rust
use tokio::sync::oneshot;

#[tokio::main]
async fn main() {
    let (tx1, rx1) = oneshot::channel();
    let (tx2, rx2) = oneshot::channel();

    let mut out = String::new();

    tokio::spawn(async move {
        // 在 `tx1` 和 `tx2` 上发送值。
# let _ = tx1.send("one");
# let _ = tx2.send("two");
    });

    tokio::select! {
        _ = rx1 => {
            out.push_str("rx1 completed");
        }
        _ = rx2 => {
            out.push_str("rx2 completed");
        }
    }

    println!("{}", out);
}
```

# 循环 (Loops)

`select!` 宏经常用在循环中。本节将通过一些示例来展示在循环中使用 `select!` 宏的常见方式。我们从选择多个通道开始：

```rust
use tokio::sync::mpsc;

#[tokio::main]
async fn main() {
    let (tx1, mut rx1) = mpsc::channel(128);
    let (tx2, mut rx2) = mpsc::channel(128);
    let (tx3, mut rx3) = mpsc::channel(128);
# tx1.clone().send("hello").await.unwrap();
# drop((tx1, tx2, tx3));

    loop {
        let msg = tokio::select! {
            Some(msg) = rx1.recv() => msg,
            Some(msg) = rx2.recv() => msg,
            Some(msg) = rx3.recv() => msg,
            else => { break }
        };

        println!("Got {:?}", msg);
    }

    println!("All channels have been closed.");
}
```

此示例在三个通道接收者之间进行选择。当在任何通道上接收到消息时，它会被写入 STDOUT。当一个通道关闭时，`recv()` 返回 `None`。通过使用模式匹配，`select!` 宏会继续等待剩余的通道。当所有通道都关闭时，将求值 `else` 分支并终止循环。

`select!` 宏随机选择分支以首先检查是否就绪。当多个通道有待处理的消息时，将随机选择一个通道进行接收。这是为了处理接收循环处理消息的速度慢于消息推入通道速度的情况，这意味着通道开始填满。如果 `select!` **没有**随机选择一个分支首先检查，则在循环的每次迭代中，会首先检查 `rx1`。如果 `rx1` 总是包含新消息，则永远不会检查剩余的通道。

> **信息**
> 如果在求值 `select!` 时，多个通道有待处理的消息，则只有一个通道的值会被弹出。所有其他通道保持不变，它们的消息会留在这些通道中，直到下一次循环迭代。不会丢失任何消息。

## 恢复异步操作 (Resuming an async operation)

现在我们将展示如何在多次调用 `select!` 之间运行异步操作。在此示例中，我们有一个项目类型为 `i32` 的 MPSC 通道和一个异步函数。我们想运行该异步函数，直到它完成或在通道上接收到一个偶数整数。

```rust
async fn action() {
    // 一些异步逻辑
}

#[tokio::main]
async fn main() {
    let (mut tx, mut rx) = tokio::sync::mpsc::channel(128);
#   tokio::spawn(async move {
#       let _ = tx.send(1).await;
#       let _ = tx.send(2).await;
#   });

    let operation = action();
    tokio::pin!(operation);

    loop {
        tokio::select! {
            _ = &mut operation => break,
            Some(v) = rx.recv() => {
                if v % 2 == 0 {
                    break;
                }
            }
        }
    }
}
```

请注意，不是在 `select!` 宏中调用 `action()`，而是在循环**外部**调用。`action()` 的返回值被赋给 `operation`，**没有**调用 `.await`。然后我们在 `operation` 上调用 `tokio::pin!`。

在 `select!` 循环内部，我们传入 `&mut operation` 而不是 `operation`。`operation` 变量正在跟踪正在进行的异步操作。循环的每次迭代都使用相同的操作，而不是发出对 `action()` 的新调用。

另一个 `select!` 分支从通道接收消息。如果消息是偶数，我们就结束循环。否则，再次启动 `select!`。

这是我们第一次使用 `tokio::pin!`。我们现在不打算深入探讨固定的细节。需要注意的是，要对引用进行 `.await`，被引用的值必须被固定 (pinned) 或实现 `Unpin`。

如果我们移除 `tokio::pin!` 行并尝试编译，会得到以下错误：

```text
error[E0599]: no method named `poll` found for struct
     `std::pin::Pin<&mut &mut impl std::future::Future>`
     in the current scope
  --> src/main.rs:16:9
   |
16 | /         tokio::select! {
17 | |             _ = &mut operation => break,
18 | |             Some(v) = rx.recv() => {
19 | |                 if v % 2 == 0 {
...  |
22 | |             }
23 | |         }
   | |_________^ method not found in
   |             `std::pin::Pin<&mut &mut impl std::future::Future>`
   |
   = note: the method `poll` exists but the following trait bounds
            were not satisfied:
           `impl std::future::Future: std::marker::Unpin`
           which is required by
           `&mut impl std::future::Future: std::future::Future`
```

尽管我们在[上一章][async.md]中介绍了 `Future`，但这个错误仍然不是很清楚。如果你在尝试对**引用**调用 `.await` 时遇到关于 `Future` 未实现的此类错误，那么该 future 可能需要被固定。

在[标准库][pin]上阅读有关 [`Pin`][pin] 的更多信息。

[pin]: https://doc.rust-lang.org/std/pin/index.html

## 修改分支 (Modifying a branch)

让我们看一个稍微复杂一点的循环。我们有：

1. 一个 `i32` 值的通道。
2. 一个要对 `i32` 值执行的异步操作。

我们想要实现的逻辑是：

1. 等待通道上的一个**偶数**。
2. 使用该偶数作为输入启动异步操作。
3. 等待该操作，但同时监听通道上是否有新的偶数。
4. 如果在现有操作完成之前接收到新的偶数，则中止现有操作并使用新的偶数重新开始。

```rust
async fn action(input: Option<i32>) -> Option<String> {
    // 如果输入是 `None`，则返回 `None`。
    // 这也可以写成 `let i = input?;`
    let i = match input {
        Some(input) => input,
        None => return None,
    };
    // 此处的异步逻辑
#   Some(i.to_string())
}

#[tokio::main]
async fn main() {
    let (mut tx, mut rx) = tokio::sync::mpsc::channel(128);

    let mut done = false;
    let operation = action(None);
    tokio::pin!(operation);

    tokio::spawn(async move {
        let _ = tx.send(1).await;
        let _ = tx.send(3).await;
        let _ = tx.send(2).await;
    });

    loop {
        tokio::select! {
            res = &mut operation, if !done => {
                done = true;

                if let Some(v) = res {
                    println!("GOT = {}", v);
                    return;
                }
            }
            Some(v) = rx.recv() => {
                if v % 2 == 0 {
                    // `.set` 是 `Pin` 上的一个方法。
                    operation.set(action(Some(v)));
                    done = false;
                }
            }
        }
    }
}
```

我们使用了与上一个示例类似的策略。异步函数在循环外部调用并赋给 `operation`。`operation` 变量被固定。循环在 `operation` 和通道接收者之间进行选择。

请注意 `action` 如何将 `Option<i32>` 作为参数。在我们收到第一个偶数之前，我们需要将 `operation` 实例化为某个东西。我们让 `action` 接受 `Option` 并返回 `Option`。如果传入 `None`，则返回 `None`。第一次循环迭代时，`operation` 立即以 `None` 完成。

此示例使用了一些新语法。第一个分支包含 `, if !done`。这是一个分支前提条件。在解释它如何工作之前，让我们看看如果省略前提条件会发生什么。省略 `, if !done` 并运行示例会产生以下输出：

```text
thread 'main' panicked at '`async fn` resumed after completion', src/main.rs:1:55
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
```

当尝试在 `operation` **已经**完成后使用它时，会发生此错误。通常，当使用 `.await` 时，被等待的值会被消耗掉。在此示例中，我们在一个引用上等待。这意味着 `operation` 在完成后仍然存在。

为避免这种 panic，我们必须小心地在 `operation` 完成时禁用第一个分支。`done` 变量用于跟踪 `operation` 是否已完成。`select!` 分支可能包含**前提条件 (precondition)**。此前提条件在 `select!` 等待分支**之前**进行检查。如果条件求值为 `false`，则该分支被禁用。`done` 变量初始化为 `false`。当 `operation` 完成时，`done` 被设置为 `true`。下一次循环迭代将禁用 `operation` 分支。当从通道接收到偶数消息时，`operation` 被重置，`done` 被设置为 `false`。

# 每任务并发 (Per-task concurrency)

`tokio::spawn` 和 `select!` 都支持运行并发异步操作。但是，用于运行并发操作的策略不同。`tokio::spawn` 函数接受一个异步操作，并生成一个新任务来运行它。任务是 Tokio 运行时调度的对象。两个不同的任务由 Tokio 独立调度。它们可能同时在不同的操作系统线程上运行。因此，生成的任务与生成的线程具有相同的限制：不能借用。

`select!` 宏在**同一任务**上并发运行所有分支。因为 `select!` 宏的所有分支都在同一任务上执行，所以它们永远不会**同时**运行。`select!` 宏在单个任务上多路复用异步操作。
