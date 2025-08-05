---
title: "Tracing 后续步骤"
---

# Tokio-console

[`tokio-console`](https://github.com/tokio-rs/console) 是一个类似于 htop 的工具，它使您能够实时查看应用程序的 span 和事件。
它还可以表示 Tokio 运行时已创建的“资源”，例如任务 (Tasks)。它在开发过程中理解性能问题至关重要。

例如，要在 [mini-redis 项目](https://github.com/tokio-rs/mini-redis) 中使用 tokio-console，
您需要为 Tokio 包启用 `tracing` 特性：

```toml
# 在您的 Cargo.toml 中更新 tokio 导入
tokio = { version = "1", features = ["full", "tracing"] }
```

注意：`full` 特性不会启用 `tracing`。

您还需要添加对 `console-subscriber` 包的依赖项。
此 crate 提供了一个 `Subscriber` 实现，它将替换 mini-redis 当前使用的实现：

```toml
# 将此添加到您的 Cargo.toml 的依赖项部分
console-subscriber = "0.1.5"
```

最后，在 `src/bin/server.rs` 中，将对 `tracing_subscriber` 的调用替换为
对 `console-subscriber` 的调用：

替换这个：

```rust
# use std::error::Error;
tracing_subscriber::fmt::try_init()?;
# Ok::<(), Box<dyn Error + Send + Sync + 'static>>(())
```

...用这个：

```rust
console_subscriber::init();
```

这将启用 `console_subscriber`，这意味着任何与 `tokio-console` 相关的检测都将被记录。
仍然会发生到 stdout 的日志记录（基于 `RUST_LOG` 环境变量的值）。

现在我们应该准备好再次启动 mini-redis，这次使用
`tokio_unstable` 标志（这是启用 tracing 所必需的）：

```sh
RUSTFLAGS="--cfg tokio_unstable" cargo run --bin mini-redis-server
```

`tokio_unstable` 标志允许我们使用 Tokio 提供的额外 API，这些 API 目前没有稳定性保证
（换句话说，允许对这些 API 进行破坏性更改）。

剩下的就是在另一个终端中运行控制台本身。
最简单的方法是从 crates.io 安装它：

```sh
cargo install --locked tokio-console
```

然后运行它：

```sh
tokio-console
```

您将看到的初始视图是当前正在运行的 tokio 任务。
示例：![tokio-console 任务视图](https://raw.githubusercontent.com/tokio-rs/console/main/assets/tasks_list.png)

它还可以显示任务完成后的时间段（这些任务的颜色将为灰色）。
您可以通过运行 mini-redis hello world 示例（在 [mini-redis 仓库](https://github.com/tokio-rs/mini-redis) 中可用）来生成一些跟踪：

```sh
cargo run --example hello_world
```

如果您按 `r`，可以切换到资源视图。这将显示正在被 Tokio 运行时使用的信号量、互斥锁和其他构造。
示例：![tokio-console 资源视图](https://raw.githubusercontent.com/tokio-rs/console/main/assets/resources.png)

每当您需要内省 Tokio 运行时以更好地了解应用程序的性能时，
您都可以使用 tokio-console 来查看实时发生的情况，帮助您发现死锁和其他问题。

要了解有关如何使用 tokio-console 的更多信息，请访问 [其文档页面](https://docs.rs/tokio-console/latest/tokio_console/#using-the-console)。

# 与 OpenTelemetry 集成

[OpenTelemetry](https://opentelemetry.io/) (OTel) 有多重含义；首先，它是一个开放规范，
定义了可以满足大多数用户需求的跟踪和指标的数据模型。它也是一组特定于语言的 SDK，
提供检测功能，以便可以从应用程序发出跟踪和指标。第三，有 OpenTelemetry Collector，
这是一个与您的应用程序一起运行的二进制文件，用于收集跟踪和指标，最终将这些数据推送到遥测供应商，
例如 DataDog、Honeycomb 或 AWS X-Ray。它也可以将数据发送到 Prometheus 等工具。

[opentelemetry crate](https://crates.io/crates/opentelemetry) 为 Rust 提供了 OpenTelemetry SDK，
这也是我们将在本教程中使用的。

在本教程中，我们将设置 mini-redis 将数据发送到 [Jaeger](https://www.jaegertracing.io/)，
Jaeger 是一个用于可视化跟踪的 UI。

要运行 Jaeger 实例，您可以使用 Docker：

```sh
docker run -d -p6831:6831/udp -p6832:6832/udp -p16686:16686 -p14268:14268 jaegertracing/all-in-one:latest
```

您可以通过访问 <http://localhost:16686> 来访问 Jaeger 页面。
它看起来像这样：
![Jaeger UI](/img/tracing-next-steps/jaeger-first-pageload.png)

一旦我们生成并发送了一些跟踪数据，我们将回到这个页面。

要设置 mini-redis，我们首先需要添加一些依赖项。使用以下内容更新您的
`Cargo.toml`：

```toml
# 实现 Otel 规范中定义的类型
opentelemetry = "0.17.0"
# tracing crate 和 opentelemetry crate 之间的集成
tracing-opentelemetry = "0.17.2"
# 允许您将数据导出到 Jaeger
opentelemetry-jaeger = "0.16.0"
```

现在，在 `src/bin/server.rs` 中，添加以下导入：

```rust
use opentelemetry::global;
use tracing_subscriber::{
    fmt, layer::SubscriberExt, util::SubscriberInitExt,
};
```

我们稍后会查看这些导入的用途。

下一步是用 OTel 设置替换对 `tracing_subscriber` 的调用。

替换这个：

```rust
# use std::error::Error;
tracing_subscriber::fmt::try_init()?;
# Ok::<(), Box<dyn Error + Send + Sync + 'static>>(())
```

...用这个：

```rust
# use std::error::Error;
# use opentelemetry::global;
# use tracing_subscriber::{
#     fmt, layer::SubscriberExt, util::SubscriberInitExt,
# };
// 允许您跨服务传递上下文（即跟踪 ID）
global::set_text_map_propagator(opentelemetry_jaeger::Propagator::new());
// 设置将数据导出到 Jaeger 所需的机制
// 还有其他 OTel crate 为前面提到的供应商提供管道。
let tracer = opentelemetry_jaeger::new_pipeline()
    .with_service_name("mini-redis")
    .install_simple()?;

// 使用配置的跟踪器创建一个 tracing 层
let opentelemetry = tracing_opentelemetry::layer().with_tracer(tracer);

// SubscriberExt 和 SubscriberInitExt trait 是扩展注册表所必需的，
// 以接受 `opentelemetry`（OpenTelemetryLayer 类型）。
tracing_subscriber::registry()
    .with(opentelemetry)
    // 继续记录到 stdout
    .with(fmt::Layer::default())
    .try_init()?;
# Ok::<(), Box<dyn Error + Send + Sync + 'static>>(())
```

现在您应该能够启动 mini-redis：

```sh
cargo run --bin mini-redis-server
```

在另一个终端中，运行 hello world 示例（在 [mini-redis 仓库](https://github.com/tokio-rs/mini-redis) 中可用）：

```sh
cargo run --example hello_world
```

现在，刷新我们打开的 Jaeger UI，在主搜索页面上，找到
“mini-redis”作为服务下拉菜单中的一个选项。

选择该选项，然后单击“查找跟踪”按钮。这应该显示我们刚刚通过运行示例发出的请求。
![Jaeger UI, mini-redis 概述](/img/tracing-next-steps/jaeger-mini-redis-overview.png)

单击跟踪应该会显示在处理 hello world 示例期间发出的 span 的详细视图。
![Jaeger UI, mini-redis 请求详细信息](/img/tracing-next-steps/jaeger-mini-redis-trace-details.png)

目前就这些了！您可以通过发送更多请求、为 mini-redis 添加额外的检测，
或使用遥测供应商（而不是我们本地运行的 Jaeger 实例）设置 OTel 来进一步探索。
对于最后一种情况，您可能需要引入一个额外的 crate（例如，要将数据发送到 OTel Collector，
您将需要 `opentelemetry-otlp` crate）。在 [opentelemetry-rust 仓库](https://github.com/open-telemetry/opentelemetry-rust/tree/main/examples) 中有很多可用的示例。

注意：mini-redis 仓库已经包含一个带有 AWS X-Ray 的完整 OpenTelemetry 示例，
其详细信息可以在 [`README`](https://github.com/tokio-rs/mini-redis#aws-x-ray-example) 以及
[`Cargo.toml`](https://github.com/tokio-rs/mini-redis/blob/24d9d9f466d9078c46477bf5c2d68416553b9872/Cargo.toml#L35-L41)
和 [`src/bin/server.rs`](https://github.com/tokio-rs/mini-redis/blob/24d9d9f466d9078c46477bf5c2d68416553b9872/src/bin/server.rs#L59-L94)
文件中找到。
