# ADR-0064: The site's accent colours come from the logo gradient

- Status: accepted
- Date: 2026-10-27

## Context

The spectator site used a blue/cyan/violet palette that did not match the logo, which fades from purple to magenta.

## Decision

The three accent variables in `src/theme.ts` take the logo's colours: `--accent` purple `#9f55d8`, `--accent2` magenta `#de3ac8`, `--accent3` `#c046d0` between them. The glow, background washes and chat bubble tints use the same colours as RGB values. Headlines, buttons, avatars and the brand text pick the change up through the variables.

## Alternatives considered

- Keep the blue palette: it clashes with the logo.
- Sample the logo more finely with extra stops: two colours match what the logo shows, and more stops add nothing.

## Consequences

The site matches the logo. The animated background canvas in `theme.ts` still draws blue and cyan, so it is a separate change if we want it to match.
