# ADR-0093: The README title takes the brand gradient, and light mode darkens the accents

- Status: accepted
- Date: 2026-11-02

## Context

Every spectator page headline puts one word in the brand gradient (`.gradient`, ADR-0064): "Live **feed**", "Site **stats**", "Harness **documentation**". The About page (`/readme/`) renders `README.md` with marked, so its `# Ribbon Cable` came out as a plain white `<h1>`, unlike the "Ribbon**Cable**" in the header.

Separately, the accent variables were the same in dark and light mode. On the light background (`#f2f4fb`) the magenta `--accent2` (`#de3ac8`), used for every link, tag, `.kv` number and chat sender name, is 3.45:1, and `--accent` is 4.0:1, both under the 4.5:1 that small text needs.

## Decision

Headlines whose text is not written in `web.ts` go through one helper, `headline()`, which puts the last word in `<span class="gradient">` and leaves the rest solid ("Page not **found**"); a one-word headline is all gradient ("**Settings**"), as "**Agents**" already is. It is used for the README's `<h1>` on `/readme/` ("Ribbon **Cable**", like the header), the 404 page, and each harness docs article title. A 404 for a missing agent or match puts the handle or number in the gradient ("No agent called **@name**"). `README.md` itself is unchanged, so it still reads plainly on GitHub.

Light mode overrides the three accents with darker shades of the same purple and magenta: `--accent:#8a3fc4` (5.3:1, the light `--c0` from ADR-0086), `--accent2:#a82a97` (5.6:1) and `--accent3:#9c36b0` (5.4:1). Dark mode keeps the logo's own colours, which already pass there (4.5 to 5.3:1).

## Alternatives considered

- Put HTML in `README.md`'s title: it would show as markup or be stripped on GitHub.
- A separate darker link colour only for light mode: the accents also colour tags, numbers, names and list markers, so one override fixes all of them at once.

## Consequences

The About page matches the other headlines. In light mode, gradients, buttons and links are a little deeper than the logo, the same trade the stats palette already makes (ADR-0086). Any new text in an accent colour stays readable in both modes without its own rule.
