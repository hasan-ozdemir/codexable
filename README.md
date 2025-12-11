# Codexa: Accessible Community Fork of Codex CLI

Codexa is an accessibility-focused, community-maintained fork of the OpenAI Codex CLI. It stays compatible with the upstream tool while adding clearer documentation and emphasizing inclusive, donation-supported development.

<p align="center"><code>npm i -g @openai/codex</code><br />or <code>brew install --cask codex</code></p>

<p align="center"><strong>Codexa</strong> builds on the open source Codex CLI and runs locally on your computer.
</br>
</br>If you want Codex in your code editor (VS Code, Cursor, Windsurf), <a href="https://developers.openai.com/codex/ide">install in your IDE</a>
</br>If you are looking for the <em>cloud-based agent</em> from OpenAI, <strong>Codex Web</strong>, go to <a href="https://chatgpt.com/codex">chatgpt.com/codex</a></p>

<p align="center">
  <img src="./.github/codex-cli-splash.png" alt="Codex CLI splash" width="80%" />
  </p>

---

## Quickstart

### Installing and running Codex CLI

Install globally with your preferred package manager. If you use npm:

```shell
npm install -g @openai/codex
```

Alternatively, if you use Homebrew:

```shell
brew install --cask codex
```

Then simply run `codex` to get started:

```shell
codex
```

If you're running into upgrade issues with Homebrew, see the [FAQ entry on brew upgrade codex](./docs/faq.md#brew-upgrade-codex-isnt-upgrading-me).

<details>
<summary>You can also go to the <a href="https://github.com/openai/codex/releases/latest">latest GitHub Release</a> and download the appropriate binary for your platform.</summary>

Each GitHub Release contains many executables, but in practice, you likely want one of these:

- macOS
  - Apple Silicon/arm64: `codex-aarch64-apple-darwin.tar.gz`
  - x86_64 (older Mac hardware): `codex-x86_64-apple-darwin.tar.gz`
- Linux
  - x86_64: `codex-x86_64-unknown-linux-musl.tar.gz`
  - arm64: `codex-aarch64-unknown-linux-musl.tar.gz`

Each archive contains a single entry with the platform baked into the name (e.g., `codex-x86_64-unknown-linux-musl`), so you likely want to rename it to `codex` after extracting it.

</details>

### Using Codex with your ChatGPT plan

<p align="center">
  <img src="./.github/codex-cli-login.png" alt="Codex CLI login" width="80%" />
  </p>

Run `codex` and select **Sign in with ChatGPT**. We recommend signing into your ChatGPT account to use Codex as part of your Plus, Pro, Team, Edu, or Enterprise plan. [Learn more about what's included in your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-in-chatgpt).

You can also use Codex with an API key, but this requires [additional setup](./docs/authentication.md#usage-based-billing-alternative-use-an-openai-api-key). If you previously used an API key for usage-based billing, see the [migration steps](./docs/authentication.md#migrating-from-usage-based-billing-api-key). If you're having trouble with login, please comment on [this issue](https://github.com/openai/codex/issues/1243).

### Model Context Protocol (MCP)

Codex can access MCP servers. To configure them, refer to the [config docs](./docs/config.md#mcp_servers).

### Configuration

Codex CLI supports a rich set of configuration options, with preferences stored in `~/.codex/config.toml`. For full configuration options, see [Configuration](./docs/config.md).

### Execpolicy

See the [Execpolicy quickstart](./docs/execpolicy.md) to set up rules that govern what commands Codex can execute.

### Docs & FAQ

- [**Getting started**](./docs/getting-started.md)
  - [CLI usage](./docs/getting-started.md#cli-usage)
  - [Slash Commands](./docs/slash_commands.md)
  - [Running with a prompt as input](./docs/getting-started.md#running-with-a-prompt-as-input)
  - [Example prompts](./docs/getting-started.md#example-prompts)
  - [Custom prompts](./docs/prompts.md)
  - [Memory with AGENTS.md](./docs/getting-started.md#memory-with-agentsmd)
- [**Configuration**](./docs/config.md)
  - [Example config](./docs/example-config.md)
- [**Sandbox & approvals**](./docs/sandbox.md)
- [**Execpolicy quickstart**](./docs/execpolicy.md)
- [**Authentication**](./docs/authentication.md)
  - [Auth methods](./docs/authentication.md#forcing-a-specific-auth-method-advanced)
  - [Login on a "Headless" machine](./docs/authentication.md#connecting-on-a-headless-machine)
- **Automating Codex**
  - [GitHub Action](https://github.com/openai/codex-action)
  - [TypeScript SDK](./sdk/typescript/README.md)
  - [Non-interactive mode (`codex exec`)](./docs/exec.md)
- [**Advanced**](./docs/advanced.md)
  - [Tracing / verbose logging](./docs/advanced.md#tracing--verbose-logging)
  - [Model Context Protocol (MCP)](./docs/advanced.md#model-context-protocol-mcp)
- [**Zero data retention (ZDR)**](./docs/zdr.md)
- [**Contributing**](./docs/contributing.md)
- [**Install & build**](./docs/install.md)
  - [System Requirements](./docs/install.md#system-requirements)
  - [DotSlash](./docs/install.md#dotslash)
  - [Build from source](./docs/install.md#build-from-source)
- [**FAQ**](./docs/faq.md)
- [**Open source fund**](./docs/open-source-fund.md)

---

## Funding / Donation Model
Codexa is free and open-source software built on top of the
openai/codex project (Apache 2.0). The project adopts a
*donation-supported* model: donations and sponsorships help sustain
the maintenance and development of this independent accessibility-focused fork.
Donations support the maintainer of this repository only.
They do not support or represent OpenAI in any way.

## Sponsorships and Donations
Codexa is free and open source.
Sponsorships and donations for this repository, whether through GitHub Sponsors
or other channels, **support only the maintenance and development of Codexa and
its independent contributors**.
They:
- Do **not** go to OpenAI  
- Do **not** represent sponsorship, endorsement, or partnership by OpenAI  
- Do **not** create any legal or contractual relationship between sponsors and
  OpenAI  
Any financial support you provide is a voluntary contribution to the maintainer
of this repository and the surrounding community work.

## License
Codexa is built on top of the open source
[openai/codex](https://github.com/openai/codex) project.
This repository contains:
- Original Codex CLI source code and related materials  
   OpenAI and the original contributors  
- Additional accessibility-related features, configuration, and documentation  
   2025 Hasan Özdemir and other Codexa contributors  
Unless explicitly stated otherwise, all source code in this repository is
distributed under the **Apache License, Version 2.0** (Apache 2.0).
The full license text is provided in the `LICENSE` file in the root of this
repository. Attribution and other informational notices that must be preserved
in redistributions or derivative works are provided in the `NOTICE` file.
By using, modifying, or redistributing this project, you agree to comply with
the terms of Apache 2.0 as they apply to both the original Codex CLI code and
any derivative work you create.

## Trademarks and Affiliation
Codexa is a **community-maintained, independent fork** of the Codex CLI project.
It is **not** an official OpenAI product and is **not** affiliated with,
endorsed by, or sponsored by OpenAI.
OpenAI, Codex, and Codex CLI may be trademarks, service marks, or
commercial names of OpenAI. Any such names are used here **solely** for the
purpose of factual reference to the original open source project and its
compatibility.
Nothing in this repository, its documentation, or its branding should be
interpreted as granting any rights in OpenAI's trademarks or other proprietary
branding.

## No Warranty and Limitation of Liability
This project is made available under the terms of the Apache License, Version
2.0. Under that license, the software is provided on an **AS IS basis,
without warranties or conditions of any kind**, whether express or implied.
Without limiting the scope of Apache 2.0, this means in particular:
- No guarantee of correctness, reliability, availability, performance, or
  fitness for any particular purpose  
- No guarantee that the software is free of security vulnerabilities or
  defects  
- No obligation on the part of the authors, maintainers, or OpenAI to provide
  support, maintenance, updates, or security patches  
To the maximum extent permitted by applicable law, neither the authors nor
contributors to this repository, nor OpenAI, shall be liable for any direct,
indirect, incidental, special, exemplary, or consequential damages arising out
of or in connection with the use of this software, even if advised of the
possibility of such damages.
For the exact legal terms, please refer to the Apache License, Version 2.0 text
in the `LICENSE` file.

## Responsibility for Use and Compliance
By using Codexa or redistributing modified versions of it, **you** are solely
responsible for:
- Complying with Apache 2.0 and any other third-party licenses that may apply  
- Complying with all applicable laws and regulations in your jurisdiction  
- Complying with the terms and policies of any platforms or services you use
  together with this project (for example, GitHub's Terms of Service, OpenAI's
  usage policies, and any relevant API terms)  
If you integrate Codexa into your own products or services, you are responsible
for ensuring that your end users receive any notices, license texts, and
disclaimers that may be required by Apache 2.0 or other applicable licenses.

## Legal Disclaimer
This section is intended to summarize how Codexa is licensed and how it relates
to the upstream OpenAI Codex CLI project, but it **does not** replace the
actual terms of the Apache License, Version 2.0, or any other applicable
license.
Nothing in this document constitutes legal advice, and no attorney-client
relationship is created by reading or relying on it. If you have questions
about your specific legal obligations, risks, or use cases (for example, using
Codexa in a commercial product or large-scale deployment), you should seek
advice from a qualified lawyer familiar with software licensing and
intellectual property law in your jurisdiction.
