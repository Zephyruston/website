---
title: "教程"
subtitle: "概述"
---

Tokio 是一个为 Rust 编程语言设计的异步运行时。它提供了编写网络应用程序所需的基本构建块。它提供了足够的灵活性，可以支持从拥有数十个核心的大型服务器到小型嵌入式设备等多种目标系统。

从高层次来看，Tokio 提供了几个主要组件：

- 一个用于执行异步代码的多线程运行时。
- 一个标准库的异步版本。
- 一个庞大的库生态系统。

# Tokio 在你的项目中的角色

当你以异步方式编写应用程序时，通过降低同时执行多任务的成本，你可以使其获得更好的可扩展性。然而，异步 Rust 代码无法自行运行，因此你必须选择一个运行时来执行它。Tokio 库是使用最广泛的运行时，其使用量超过了所有其他运行时的总和。

此外，Tokio 还提供了许多实用的工具。在编写异步代码时，你不能使用 Rust 标准库提供的普通阻塞 API，而必须使用它们的异步版本。这些替代版本由 Tokio 提供，并在适当的地方镜像了 Rust 标准库的 API。

# Tokio 的优势

本节将概述 Tokio 的一些优势。

## 快速

Tokio 很**快速**，它构建于 Rust 编程语言之上，而 Rust 本身就是快速的。这遵循了 Rust 的精神，其目标是让你无法通过手动编写等效代码来提高性能。

Tokio 很**可扩展**，它构建于 async/await 语言特性之上，而该特性本身也是可扩展的。在处理网络时，由于延迟的存在，处理单个连接的速度有一个极限，因此扩展的唯一方法是同时处理许多连接。借助 async/await 语言特性，增加并发操作的数量变得非常廉价，从而使你能够扩展到大量的并发任务。

## 可靠

Tokio 使用 Rust 构建，Rust 是一门赋予每个人构建可靠和高效软件能力的语言。[多项研究][microsoft][chrome]发现，大约 70% 的高严重性安全漏洞是内存不安全造成的。使用 Rust 可以在你的应用程序中消除整类此类错误。

Tokio 还非常注重提供一致的行为，避免意外。Tokio 的主要目标是允许用户部署可预测的软件，这些软件将日复一日地稳定运行，具有可靠的响应时间且不会出现不可预测的延迟峰值。

[microsoft]: https://www.zdnet.com/article/microsoft-70-percent-of-all-security-bugs-are-memory-safety-issues/
[chrome]: https://www.chromium.org/Home/chromium-security/memory-safety

## 简单

借助 Rust 的 async/await 特性，编写异步应用程序的复杂性已大大降低。再配合 Tokio 的实用工具和充满活力的生态系统，编写应用程序变得轻而易举。

在适当的情况下，Tokio 遵循标准库的命名约定。这使得可以轻松地将仅使用标准库编写的代码转换为使用 Tokio 编写的代码。凭借 Rust 强大的类型系统，轻松编写正确代码的能力是无与伦比的。

## 灵活

Tokio 提供了多种运行时变体。从多线程的[工作窃取 (work-stealing)][work-stealing]运行时到轻量级的单线程运行时，应有尽有。这些运行时都提供了许多可调选项，允许用户根据自己的需求进行调整。

[work-stealing]: https://en.wikipedia.org/wiki/Work_stealing

# 何时不使用 Tokio

尽管 Tokio 对于许多需要同时执行大量任务的项目非常有用，但在某些用例中，Tokio 并不是一个合适的选择。

- 通过在多个线程上并行运行来加速 CPU 密集型计算。Tokio 是为 IO 密集型应用程序设计的，在这些应用程序中，每个单独的任务大部分时间都在等待 IO。如果你的应用程序只做并行计算，你应该使用 [rayon]。也就是说，如果你需要同时处理这两种情况，仍然可以进行“混合搭配”。有关实际示例，请参阅[这篇博客文章][rayon-example]。
- 读取大量文件。虽然 Tokio 似乎对于只需要读取大量文件的项目很有用，但与普通的线程池相比，Tokio 在此方面并无优势。这是因为操作系统通常不提供异步文件 API。
- 发送单个 Web 请求。Tokio 能给你带来优势的地方是当你需要同时做很多事情的时候。如果你需要使用一个为异步 Rust 设计的库，例如 [reqwest]，但你不需要同时做很多事情，你应该优先使用该库的阻塞版本，因为它会使你的项目更简单。当然，使用 Tokio 仍然可以，但与阻塞 API 相比并没有真正的优势。如果该库不提供阻塞 API，请参阅[关于与同步代码桥接的章节][bridging]。

[rayon]: https://docs.rs/rayon/
[rayon-example]: https://ryhl.io/blog/async-what-is-blocking/#the-rayon-crate
[reqwest]: https://docs.rs/reqwest/
[bridging]: /tokio/topics/bridging

# 获取帮助

在任何时候，如果你遇到困难，都可以在 [Discord] 或 [GitHub 讨论][disc]上寻求帮助。不要担心问“新手”问题。我们都是从新手开始的，并且很乐意提供帮助。

[discord]: https://discord.gg/tokio
[disc]: https://github.com/tokio-rs/tokio/discussions
