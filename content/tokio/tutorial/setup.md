---
title: "设置"
---

本教程将逐步引导你完成构建 [Redis] 客户端和服务器的过程。我们将从 Rust 异步编程的基础知识开始，并在此基础上逐步构建。我们将实现 Redis 命令的一个子集，但将对 Tokio 进行一次全面的介绍。

# Mini-Redis

你将在本教程中构建的项目已作为 [Mini-Redis on GitHub][mini-redis] 提供。Mini-Redis 的设计初衷是学习 Tokio，因此注释非常详尽，但这也意味着 Mini-Redis 缺少真实 Redis 库中你可能需要的一些功能。你可以在 [crates.io](https://crates.io/) 上找到生产就绪的 Redis 库。

我们将在教程中直接使用 Mini-Redis。这允许我们在教程后面实现它们之前，就在教程中使用 Mini-Redis 的部分功能。

# 获取帮助

在任何时候，如果你遇到困难，都可以在 [Discord] 或 [GitHub 讨论][disc]上寻求帮助。不要担心问“新手”问题。我们都是从新手开始的，并且很乐意提供帮助。

[discord]: https://discord.gg/tokio
[disc]: https://github.com/tokio-rs/tokio/discussions

# 先决条件

读者应已熟悉 [Rust]。[Rust 书][book] 是一个非常好的入门资源。

虽然不是必需的，但一些使用 [Rust 标准库][std] 或其他语言编写网络代码的经验会很有帮助。

不需要预先具备 Redis 的知识。

[rust]: https://rust-lang.org
[book]: https://doc.rust-lang.org/book/
[std]: https://doc.rust-lang.org/std/

## Rust

在开始之前，你应该确保已安装 [Rust][install-rust] 工具链并准备就绪。如果你还没有安装，最简单的安装方法是使用 [rustup]。

本教程至少需要 Rust 版本 `1.45.0`，但推荐使用最新的稳定版 Rust。

要检查你的计算机上是否安装了 Rust，请运行以下命令：

```bash
$ rustc --version
```

你应该会看到类似 `rustc 1.46.0 (04488afe3 2020-08-24)` 的输出。

## Mini-Redis 服务器

接下来，安装 Mini-Redis 服务器。这将用于在我们构建客户端时对其进行测试。

```bash
$ cargo install mini-redis
```

通过启动服务器来确保它已成功安装：

```bash
$ mini-redis-server
```

然后，在单独的终端窗口中，尝试使用 `mini-redis-cli` 获取键 `foo`

```bash
$ mini-redis-cli get foo
```

你应该会看到 `(nil)`。

# 准备就绪

就是这样，一切都准备就绪。转到下一页编写你的第一个异步 Rust 应用程序。

[redis]: https://redis.io
[mini-redis]: https://github.com/tokio-rs/mini-redis
[install-rust]: https://www.rust-lang.org/tools/install
[rustup]: https://rustup.rs/
