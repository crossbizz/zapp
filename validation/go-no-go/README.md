# M6 go/no-go evaluator

`policy.json` encodes the eight PRD section 37.6 validation thresholds and all
seven section 40.4 invalidation signals without rounding the strict boundaries.

Validate the policy:

```sh
pnpm validation:go-no-go-policy
```

After V-2 produces its `repeat-change-results` artifact and V-5 supplies an
`agency-validation-results` artifact for the first-five-agency sample, copy
`results.template.json`, fill every numerator and denominator, and link both
artifacts with their SHA-256 digests before evaluating it:

```sh
node validation/go-no-go/evaluate.mjs path/to/results.json
```

Exit status is `0` for go, `1` for no-go, and `2` when measurements are missing.
Exactly 90%, 70%, or 75% fails the three “above” targets; exactly 5% or 25%
fails the two “below” targets. Agency willingness is a count from exactly the
first five agencies, not an arbitrary percentage.
