---
title: "I/O"
---

Tokio 中的 I/O 操作方式与 `std` 中的非常相似，但是是异步的。有一个用于读取的 trait ([`AsyncRead`]) 和一个用于写入的 trait ([`AsyncWrite`])。特定类型会根据需要实现这些 trait ([`TcpStream`], [`File`], [`Stdout`])。[`AsyncRead`] 和 [`AsyncWrite`] 也由许多数据结构实现，例如 `Vec<u8>` 和 `&[u8]`。这允许在需要读取器或写入器的地方使用字节数组。

本页将介绍使用 Tokio 进行基本的 I/O 读写，并通过几个示例进行讲解。下一页将介绍一个更高级的 I/O 示例。

# `AsyncRead` 和 `AsyncWrite`

这两个 trait 提供了异步读取和写入字节流的功能。这些 trait 上的方法通常不会直接调用，类似于你不会手动调用 `Future` trait 中的 `poll` 方法。相反，你将通过 [`AsyncReadExt`] 和 [`AsyncWriteExt`] 提供的实用方法来使用它们。

让我们简要地看一下其中的一些方法。所有这些函数都是 `async` 的，必须与 `.await` 一起使用。

## `async fn read()`

[`AsyncReadExt::read`][read] 提供了一个异步方法，用于将数据读取到缓冲区中，并返回读取的字节数。

**注意：** 当 `read()` 返回 `Ok(0)` 时，这表示流已关闭。任何对 `read()` 的进一步调用都将立即返回 `Ok(0)`。对于 [`TcpStream`] 实例，这表示套接字的读取半部分已关闭。

```rust
use tokio::fs::File;
use tokio::io::{self, AsyncReadExt};

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let mut f = File::open("foo.txt").await?;
    let mut buffer = [0; 10];

    // 最多读取 10 个字节
    let n = f.read(&mut buffer[..]).await?;

    println!("The bytes: {:?}", &buffer[..n]);
    Ok(())
}
# }
```

## `async fn read_to_end()`

[`AsyncReadExt::read_to_end`][read_to_end] 从流中读取所有字节，直到 EOF。

```rust
use tokio::io::{self, AsyncReadExt};
use tokio::fs::File;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let mut f = File::open("foo.txt").await?;
    let mut buffer = Vec::new();

    // 读取整个文件
    f.read_to_end(&mut buffer).await?;
    Ok(())
}
# }
```

## `async fn write()`

[`AsyncWriteExt::write`][write] 将一个缓冲区写入写入器，并返回写入了多少字节。

```rust
use tokio::io::{self, AsyncWriteExt};
use tokio::fs::File;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let mut file = File::create("foo.txt").await?;

    // 写入字节字符串的一部分，但不一定是全部。
    let n = file.write(b"some bytes").await?;

    println!("Wrote the first {} bytes of 'some bytes'.", n);
    Ok(())
}
# }
```

## `async fn write_all()`

[`AsyncWriteExt::write_all`][write_all] 将整个缓冲区写入写入器。

```rust
use tokio::io::{self, AsyncWriteExt};
use tokio::fs::File;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let mut file = File::create("foo.txt").await?;

    file.write_all(b"some bytes").await?;
    Ok(())
}
# }
```

这两个 trait 都包含许多其他有用的方法。有关完整列表，请参阅 API 文档。

# 辅助函数 (Helper functions)

此外，就像 `std` 一样，[`tokio::io`] 模块也包含许多有用的实用函数，以及用于处理[标准输入][stdin]、[标准输出][stdout]和[标准错误][stderr]的 API。例如，[`tokio::io::copy`][copy] 异步地将读取器的全部内容复制到写入器中。

```rust
use tokio::fs::File;
use tokio::io;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let mut reader: &[u8] = b"hello";
    let mut file = File::create("foo.txt").await?;

    io::copy(&mut reader, &mut file).await?;
    Ok(())
}
# }
```

请注意，这利用了字节数组也实现 `AsyncRead` 的事实。

# Echo 服务器 (Echo server)

让我们练习执行一些异步 I/O。我们将编写一个 echo 服务器。

echo 服务器绑定一个 `TcpListener` 并在循环中接受入站连接。对于每个入站连接，从套接字读取数据并立即写回到套接字中。客户端向服务器发送数据，并接收完全相同的数据。

我们将使用两种略有不同的策略实现两次 echo 服务器。

## 使用 `io::copy()`

首先，我们将使用 [`io::copy`][copy] 实用程序来实现 echo 逻辑。

你可以将此代码写入一个新的二进制文件中：

```bash
$ touch src/bin/echo-server-copy.rs
```

你可以通过以下命令启动（或仅检查编译）：

```bash
$ cargo run --bin echo-server-copy
```

你将能够使用标准的命令行工具（如 `telnet`）或通过编写一个简单的客户端（例如 [`tokio::net::TcpStream`][tcp_example] 文档中的客户端）来尝试该服务器。

这是一个 TCP 服务器，需要一个接受循环。为每个接受的套接字生成一个新任务来处理。

```rust
use tokio::io;
use tokio::net::TcpListener;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:6142").await?;

    loop {
        let (mut socket, _) = listener.accept().await?;

        tokio::spawn(async move {
            // 在这里复制数据
        });
    }
}
# }
```

如前所述，这个实用函数接受一个读取器和一个写入器，并将数据从一个复制到另一个。但是，我们只有一个 `TcpStream`。这个单一值实现了 `AsyncRead` **和** `AsyncWrite`。因为 `io::copy` 需要读取器和写入器的 `&mut`，所以套接字不能用于两个参数。

```rust,compile_fail
// 这无法编译
io::copy(&mut socket, &mut socket).await
```

## 拆分读取器 + 写入器 (Splitting a reader + writer)

为了解决这个问题，我们必须将套接字拆分为一个读取器句柄和一个写入器句柄。拆分读取器/写入器组合的最佳方法取决于具体的类型。

任何读取器 + 写入器类型都可以使用 [`io::split`][split] 实用程序进行拆分。此函数接受一个值并返回独立的读取器和写入器句柄。这两个句柄可以独立使用，包括在不同的任务中。

例如，echo 客户端可以这样处理并发读写：

```rust
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let socket = TcpStream::connect("127.0.0.1:6142").await?;
    let (mut rd, mut wr) = io::split(socket);

    // 在后台写入数据
    tokio::spawn(async move {
        wr.write_all(b"hello\r\n").await?;
        wr.write_all(b"world\r\n").await?;

        // 有时，Rust 类型推断器需要一点帮助
        Ok::<_, io::Error>(())
    });

    let mut buf = vec![0; 128];

    loop {
        let n = rd.read(&mut buf).await?;

        if n == 0 {
            break;
        }

        println!("GOT {:?}", &buf[..n]);
    }

    Ok(())
}
# }
```

因为 `io::split` 支持**任何**实现了 `AsyncRead + AsyncWrite` 的值并返回独立的句柄，所以 `io::split` 在内部使用 `Arc` 和 `Mutex`。对于 `TcpStream`，可以避免这种开销。`TcpStream` 提供两个专门的拆分函数。

[`TcpStream::split`] 接受流的**引用**并返回一个读取器和写入器句柄。因为使用的是引用，所以两个句柄必须保持在调用 `split()` 的**同一**任务中。这种专门的 `split` 是零成本的。不需要 `Arc` 或 `Mutex`。`TcpStream` 还提供了 [`into_split`]，它支持句柄可以在任务之间移动，代价只有一个 `Arc`。

因为 `io::copy()` 在拥有 `TcpStream` 的同一任务上调用，我们可以使用 [`TcpStream::split`]。服务器中处理 echo 逻辑的任务变为：

```rust
# use tokio::io;
# use tokio::net::TcpStream;
# fn dox(mut socket: TcpStream) {
tokio::spawn(async move {
    let (mut rd, mut wr) = socket.split();

    if io::copy(&mut rd, &mut wr).await.is_err() {
        eprintln!("failed to copy");
    }
});
# }
```

你可以在[这里][full_copy]找到完整的代码。

## 手动复制 (Manual copying)

现在让我们看看如何通过手动复制数据来编写 echo 服务器。为此，我们使用 [`AsyncReadExt::read`][read] 和 [`AsyncWriteExt::write_all`][write_all]。

完整的 echo 服务器如下：

```rust
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

# fn dox() {
#[tokio::main]
async fn main() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:6142").await?;

    loop {
        let (mut socket, _) = listener.accept().await?;

        tokio::spawn(async move {
            let mut buf = vec![0; 1024];

            loop {
                match socket.read(&mut buf).await {
                    // `Ok(0)` 的返回值表示远程端已关闭
                    Ok(0) => return,
                    Ok(n) => {
                        // 将数据复制回套接字
                        if socket.write_all(&buf[..n]).await.is_err() {
                            // 意外的套接字错误。我们在这里能做的很有限，
                            // 所以就停止处理。
                            return;
                        }
                    }
                    Err(_) => {
                        // 意外的套接字错误。我们在这里能做的很有限，
                        // 所以就停止处理。
                        return;
                    }
                }
            }
        });
    }
}
# }
```

（你可以将此代码放入 `src/bin/echo-server.rs` 并使用 `cargo run --bin echo-server` 启动它）。

让我们来分解一下。首先，因为使用了 `AsyncRead` 和 `AsyncWrite` 实用程序，所以必须将扩展 trait 引入作用域。

```rust
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
```

## 分配缓冲区 (Allocating a buffer)

策略是从套接字读取一些数据到缓冲区，然后将缓冲区的内容写回到套接字。

```rust
let mut buf = vec![0; 1024];
```

这里明确避免了栈缓冲区。回想一下[之前][send]的内容，我们注意到所有在 `.await` 调用期间存在的任务数据都必须由任务存储。在本例中，`buf` 在 `.await` 调用之间使用。所有任务数据都存储在单个分配中。你可以将其视为一个 `enum`，其中每个变体是为特定 `.await` 调用而需要存储的数据。

如果缓冲区由栈数组表示，则每个接受的套接字生成的任务的内部结构可能类似于：

```rust,compile_fail
struct Task {
    // 此处为内部任务字段
    task: enum {
        AwaitingRead {
            socket: TcpStream,
            buf: [BufferType],
        },
        AwaitingWriteAll {
            socket: TcpStream,
            buf: [BufferType],
        }

    }
}
```

如果使用栈数组作为缓冲区类型，它将*内联 (inline)* 存储在任务结构中。这将使任务结构非常大。此外，缓冲区大小通常是页面大小的。这反过来又会使 `Task` 成为一个尴尬的大小：`$page-size + a-few-bytes`。

编译器对 async 块的布局优化比基本的 `enum` 更进一步。实际上，变量不会像 `enum` 那样在变体之间移动。但是，任务结构体的大小至少与最大的变量一样大。

因此，为缓冲区使用专用分配通常更有效。

## 处理 EOF (Handling EOF)

当 TCP 流的读取半部分关闭时，对 `read()` 的调用返回 `Ok(0)`。此时退出读取循环非常重要。忘记在 EOF 时退出读取循环是一个常见的 bug 来源。

```rust
# use tokio::io::AsyncReadExt;
# use tokio::net::TcpStream;
# async fn dox(mut socket: TcpStream) {
# let mut buf = vec![0_u8; 1024];
loop {
    match socket.read(&mut buf).await {
        // `Ok(0)` 的返回值表示远程端已关闭
        Ok(0) => return,
        // ... 此处处理其他情况
# _ => unreachable!(),
    }
}
# }
```

忘记退出读取循环通常会导致 100% CPU 的无限循环情况。由于套接字已关闭，`socket.read()` 会立即返回。然后循环将永远重复下去。

完整代码可以在[这里][full_manual]找到。

[full_manual]: https://github.com/tokio-rs/website/blob/master/tutorial-code/io/src/echo-server.rs
[full_copy]: https://github.com/tokio-rs/website/blob/master/tutorial-code/io/src/echo-server-copy.rs
[send]: /tokio/tutorial/spawning#send-bound
[`AsyncRead`]: https://docs.rs/tokio/1/tokio/io/trait.AsyncRead.html
[`AsyncWrite`]: https://docs.rs/tokio/1/tokio/io/trait.AsyncWrite.html
[`AsyncReadExt`]: https://docs.rs/tokio/1/tokio/io/trait.AsyncReadExt.html
[`AsyncWriteExt`]: https://docs.rs/tokio/1/tokio/io/trait.AsyncWriteExt.html
[`TcpStream`]: https://docs.rs/tokio/1/tokio/net/struct.TcpStream.html
[`File`]: https://docs.rs/tokio/1/tokio/fs/struct.File.html
[`Stdout`]: https://docs.rs/tokio/1/tokio/io/struct.Stdout.html
[read]: https://docs.rs/tokio/1/tokio/io/trait.AsyncReadExt.html#method.read
[read_to_end]: https://docs.rs/tokio/1/tokio/io/trait.AsyncReadExt.html#method.read_to_end
[write]: https://docs.rs/tokio/1/tokio/io/trait.AsyncWriteExt.html#method.write
[write_all]: https://docs.rs/tokio/1/tokio/io/trait.AsyncWriteExt.html#method.write_all
[`tokio::io`]: https://docs.rs/tokio/1/tokio/io/index.html
[stdin]: https://docs.rs/tokio/1/tokio/io/fn.stdin.html
[stdout]: https://docs.rs/tokio/1/tokio/io/fn.stdout.html
[stderr]: https://docs.rs/tokio/1/tokio/io/fn.stderr.html
[copy]: https://docs.rs/tokio/1/tokio/io/fn.copy.html
[split]: https://docs.rs/tokio/1/tokio/io/fn.split.html
[`TcpStream::split`]: https://docs.rs/tokio/1/tokio/net/struct.TcpStream.html#method.split
[`into_split`]: https://docs.rs/tokio/1/tokio/net/struct.TcpStream.html#method.into_split
[tcp_example]: https://docs.rs/tokio/1/tokio/net/struct.TcpStream.html#examples
