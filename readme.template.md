<div align="center">

<img src="./logo.png" alt="Paperless-AI next logo" width="400">

<h1>Paperless-AI <span style="font-size: 0.62em; color: #2563eb; font-weight: 700;">next</span></h1>

[![Latest Release](https://img.shields.io/github/v/release/admonstrator/paperless-ai-next?style=for-the-badge&logo=github&color=0ea5e9)](https://github.com/admonstrator/paperless-ai-next/releases/latest) [![Docker Pulls](https://img.shields.io/docker/pulls/admonstrator/paperless-ai-next?style=for-the-badge&logo=docker&color=10b981)](https://hub.docker.com/r/admonstrator/paperless-ai-next) [![Docs](https://img.shields.io/badge/docs-Live-0891b2?style=for-the-badge&logo=readthedocs)](https://paperless-ai-next.admon.me/)

[🧠 What makes it "Next"](#-the-evolution-what-makes-it-next) | [💖 Fuel the Evolution](#-fuel-the-evolution) | [🚀 Quick Start](#-quick-start) | [💬 Frequently Asked Questions](#-frequently-asked-questions)

</div>

---

## 📊 At a Glance: Next vs. Original

| Feature                                     | Paperless-AI | Paperless-AI <span style="font-size: 0.62em; color: #2563eb; font-weight: 700;">next</span> |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| **Core automation**                         |              |                                                                                             |
| AI-based document classification            | ✅            | ✅                                                                                           |
| Paperless-ngx integration                   | ✅            | ✅                                                                                           |
| Basic manual processing flows               | ✅            | ✅                                                                                           |
| **Performance and scale**                   |              |                                                                                             |
| Server-side history pagination              | ❌            | ✅                                                                                           |
| Tag caching with reduced API calls          | ❌            | ✅                                                                                           |
| Faster dashboard behavior under high volume | ❌            | ✅                                                                                           |
| **Security and reliability**                |              |                                                                                             |
| Security-focused dependency maintenance     | ✅            | ✅                                                                                           |
| Global API + SSE rate limiting              | ❌            | ✅                                                                                           |
| MFA login support                           | ❌            | ✅                                                                                           |
| **OCR and recovery workflows**              |              |                                                                                             |
| Works with blurry documents and images      | ❌            | ✅                                                                                           |
| **UX and operations**                       |              |                                                                                             |
| Searchable document picker in chat          | ❌            | ✅                                                                                           |
| Settings tabs with runtime ENV hints        | ❌            | ✅                                                                                           |

---

## 🚀 The Evolution: What makes it "Next"?

This isn't just a collection of patches; it's a total overhaul of how your documents interact with AI. I took the original logic and ran it through a "Does this actually make my life easier?" filter.

### 🧠 High-IQ Classification

Connect to OpenAI, Ollama, or any OpenAI-compatible API. We've moved beyond simple keyword matching. The AI now understands **intent and context**, meaning it knows the difference between an "Electricity Bill" and a "Manual for a Toaster" without you writing a single regex.

### 👓 Flexible OCR Vision (Mistral + Local)

Waging war against blurry scans, shaky smartphone photos, and handwritten scribbles that standard OCR usually chokes on. You can run OCR with:

- Mistral OCR (`provider: mistral`)
- local OpenAI-compatible vision APIs (`provider: ollama` + `/v1` endpoint, e.g. LM Studio-compatible)
- native Ollama chat vision APIs (`provider: ollama` + `/api/chat` endpoint)

The OCR setup now also validates real image reading instead of only checking endpoint reachability.

### ⚡️ Performance without the "Spinner-Induced Rage"

I hated the lag in the original UI. I've implemented **server-side pagination** and **aggressive tag caching**. Whether you're managing 100 documents or 10,000, the dashboard stays snappy and your browser stays alive.

### 🛡️ Hardened for Production

I use this for my own life and my own documents. That means security isn't an afterthought - it's a requirement. Expect regular dependency updates, a reduced container attack surface, and error handling that fails gracefully instead of taking your whole stack down with it.

### 🧩 The "Best of" Community DNA

There were dozens of brilliant ideas and PRs left gathering dust in the original repository. I've personally hand-picked, tested, and integrated the best community suggestions, making this the most feature-complete version of the tool available.

### 🤖 Vibe-Coded, Human-Vetted

Built with heavy AI assistance but steered by human common sense. It's _vibe-coded_ in the sense that I prioritize how the tool _actually feels_ to use over rigid corporate specs. Yet it's engineered to be more stable than your enterprise-driven _Microsoft Access '97_ ~~nightmare~~ business software.

---

## 💖 Fuel the Evolution

Maintaining this solo, chasing bugs, and keeping up with the rapid pace of AI is a massive labor of love. If this tool saves your sanity (and your weekends), consider fueling the next update. Whether it's a cold energy drink or just a "thanks"; your support keeps the code flowing.

<div align="center">

[![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsors-EA4AAA?style=for-the-badge&logo=github)](https://github.com/sponsors/admonstrator) [![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/admon) [![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/aaronviehl) [![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/admon)

</div>

---

## ⚠️ A Note on Stability & Migration

**Data is sacred. Back it up.**

Because **Paperless-AI <span style="font-size: 0.62em; color: #2563eb; font-weight: 700;">next</span>** introduces significant architectural improvements and new database logic, it's a "one-way street" evolution. Since I am cleaning up and optimizing the core logic plus adding new features, there is no guarantee of stability right now.

> However, I develop this for my own production environment, so I have zero interest in breaking things. However, every server is different. **Please create a full backup of your Paperless-ngx**. If you're coming from the original version, a fresh install is often the cleanest path to document zen.

---

## 🚀 Quick Start

### Docker Compose (Recommended)

Please check the docker variables [here](https://paperless-ai-next.admon.me/getting-started/configuration/#docker-environment-variables) for all configuration options.

> If you are using plain HTTP (like running **Paperless-AI <span style="font-size: 0.62em; color: #2563eb; font-weight: 700;">next</span>** locally on your NAS, your PC, or in your home network), make sure to set `COOKIE_SECURE_MODE=never` to avoid login issues! See [Configuration](/getting-started/configuration/#cookie-and-proxy-flags-all-supported-values) for details. Using a reverse proxy like Nginx or Caddy with HTTPS is highly recommended for security and performance, especially if you expose the service to the internet.

**Lite version** – AI tagging & OCR only (~500–700 MB):

```yaml
services:
  paperless-ai-next:
    image: admonstrator/paperless-ai-next:latest
    container_name: paperless-ai-next
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - data:/app/data

volumes:
  data:
```

Then open [http://localhost:3000](http://localhost:3000) to complete setup.

### OCR Provider Notes

- OCR API key env: `OCR_API_KEY` (backward-compatible fallback: `MISTRAL_API_KEY`)
- Local OCR supports model discovery from both `/api/tags` (Ollama-style) and `/v1/models` (OpenAI-compatible)
- OCR test sends a real PNG image and expects the exact token: `OCR-TEST-182730173401`
- For OpenAI-compatible endpoints that reject data URLs, OCR validation automatically retries with raw base64 payload

### Container Images

| Image Tag                                    | Size        |
| -------------------------------------------- | ----------- |
| `admonstrator/paperless-ai-next:latest`      | ~500–700 MB |


**Docker Hub:** [admonstrator/paperless-ai-next](https://hub.docker.com/r/admonstrator/paperless-ai-next)

Versioned release tags use the format `vYYYY.MM.##` (example: `v2026.03.01`).

---

## 💬 Frequently Asked Questions

### "Is this project stable if it's vibe-coded?"

**Short answer:** I use it every day for my actual documents. If it breaks, my own life becomes a chaotic mess of untagged invoices—so I have a very strong biological incentive to keep it stable.

**Long answer:** It's not _vibe-coded_ in the sense of being random; I test every feature and try to automate as much of the testing as possible. And _NO!_ it's not just one pile of AI-generated code inside a main.js file. Since I work as an IT architect, I understand the importance of maintainable code.

### "So you don't read the code? Should I be worried?"

I don't read it like a monk reading ancient scrolls, but I do understand the **logic**. I treat AI like a more or less talented, slightly erratic junior dev. I tell it what to build, I test the hell out of it, and if it fails, we go back to the drawing board. I am the filter. No "AI-slop" gets merged without passing my "Does this actually solve the problem?" test. Or at least, it doesn't stay merged if I encounter issues in production.

### "What if I'm a 'real' developer and I find a bug?"

**Please, for the love of all that is holy, open a PR.** I welcome everyone; from fellow vibe-coders to the wizards who actually understand memory management. If you see something that makes your inner _Senior Architect_ cry, fix it and send it over. I'm happy to learn, as long as we keep the "it just works" spirit alive.

### "Why should I use this instead of the original project?"

If the original works for you, stay there! But if you're tired of loading spinners, want better AI and OCR, then **Paperless-AI <span style="font-size: 0.62em; color: #2563eb; font-weight: 700;">next</span>** is for you. It's a more polished, more powerful, and more user-friendly evolution of the original vision.

### "Does this support [Specific Niche AI Provider]?"

If it's OpenAI-compatible, it probably works. If not, open an issue! Since I have an AuDHD brain, I'm prone to hyper-focusing on cool new features — so if your suggestion catches my interest, it might be implemented before my second energy drink.

---

<div align="center">

**Paperless-AI <span style="font-size: 0.62em; color: #2563eb; font-weight: 700;">next</span> is made with ❤️ by admon for the community**

⭐ If you find this useful, please star the repository!

</div>
