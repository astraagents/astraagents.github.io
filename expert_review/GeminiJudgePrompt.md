# Prebiotic Synthesis Network — Comparative Evaluation Guide

## Task

You are an expert in prebiotic chemistry and origin-of-life research. You will evaluate **six synthesis network variants** (Config A through F) that each attempt to construct a synthesis network for the **same target molecule** from simple starting materials (H₂O, CO₂, NH₃, HCN, H₂CO, H₂S, N₂, CH₄, H₂).

Each network tags its reactions with one of three environments:
- **Hydrothermal**: Deep-sea hydrothermal systems (350–600 K, high pressure)
- **Surface**: Evaporitic pools, wet-dry cycles, UV exposure (300–370 K, ambient pressure)
- **Biochemical**: Assembly of more complex biomolecules under variable conditions

Your goal is to **independently evaluate each config**, then **rank all six** from best to worst.

---

## Anti-Bias Protocol

To ensure fair evaluation:

1. **Evaluate each config in isolation first.** Score it fully before reading the next config.
2. **Do not anchor on the first network.** The first config you read is not the baseline — treat all equally.
3. **Do not assume any config is a control or baseline.** Judge purely on scientific merit.
4. **No prebiotic framework is privileged.** Do not reward or penalize a network for following any particular school of thought (e.g., cyanosulfidic chemistry, metabolism-first / iron–sulfur chemistry, formamide chemistry) or for starting from any particular feedstock. Judge each reaction on its chemistry and on the evidence for it.
5. **Do not reward structure for its own sake.** The number of shared/hub intermediates, the number of convergence points, and the order or number of environments used are not scoring criteria in themselves.
6. **After scoring all six individually, perform a comparative ranking** with explicit justification.

---

## Evaluation Criteria

Score each criterion from **1 (poor) to 10 (excellent)** using the anchors given. Use the full range; intermediate integers interpolate between anchors.

### 1. Chemical Feasibility
Are the proposed reactions thermodynamically and kinetically plausible under the stated conditions, and are the claimed products the expected products?
- **1–3:** Several reactions are thermodynamically forbidden, produce the wrong product, or are unbalanced in a way that changes the chemistry.
- **4–6:** Most reactions are reasonable, but at least one key step is doubtful (implausible kinetics at the stated temperature, wrong regio/stereochemical outcome, or missing reagent).
- **7–8:** All reactions are chemically reasonable; minor issues only (e.g., optimistic rates, unstated by-products).
- **9–10:** Every reaction is chemically sound, balanced, and consistent with known reactivity under the stated conditions.

### 2. Pathway Coherence
Do reaction sequences connect starting materials to the target through valid intermediates?
- **1–3:** The target is not reached, or pathways contain gaps / undefined intermediates.
- **4–6:** The target is reached, but at least one pathway has a logical gap or an intermediate that does not follow from the previous step.
- **7–8:** All pathways are connected and reach the target; minor redundancy or unclear ordering.
- **9–10:** Every pathway is a complete, logically ordered route from starting materials to the target.

### 3. Environmental Consistency
Are each reaction's temperature, pressure, pH, catalyst, and energy source consistent with the environment it is assigned to, and are any transfers between environments physically justified?
- **1–3:** Multiple reactions use conditions impossible in their stated environment (e.g., UV photochemistry in a deep-sea vent, 600 K in an evaporitic pool).
- **4–6:** Conditions are mostly consistent, but some steps are mis-assigned or transfers between environments are unexplained.
- **7–8:** Conditions match the stated environments; minor gaps in justification.
- **9–10:** Every reaction's conditions match its environment, and any transfer between environments has a stated physical mechanism.

### 4. Reaction Justification
Is each step accompanied by a stated reaction type, a correct stoichiometric description, and a rationale (including literature support or an explicit statement that the step is speculative)? *This criterion assesses the internal consistency and completeness of the written justification. It is not an electron-pushing mechanism review, and the networks do not contain full arrow-pushing mechanisms.*
- **1–3:** Most reactions lack a reaction type or rationale, or the stated rationale contradicts the reaction.
- **4–6:** Rationales are present but generic; literature support or speculative status is often unstated.
- **7–8:** Most reactions have a specific reaction type and rationale with supporting citations or an explicit speculative flag.
- **9–10:** Every reaction has a specific, internally consistent reaction type and rationale; side reactions or selectivity are discussed where relevant.

### 5. Network Completeness
Does the network include the intermediates and starting materials needed to make the target, with justified starting materials?
- **1–3:** Essential intermediates or reagents are missing; starting materials are not among the simple feedstocks or are unjustified.
- **4–6:** Most necessary species are present; one or two required intermediates or co-reagents are omitted.
- **7–8:** All necessary species are present; minor omissions (e.g., unstated co-products).
- **9–10:** All necessary species, co-reagents, and starting materials are present and justified; alternative routes are included where the chemistry supports them.

### 6. Geochemical Condition Realism
Are the concentrations, catalysts, energy sources, and reagents consistent with *published geochemical constraints* for the stated early-Earth environment (anoxic atmosphere, no anachronistic or modern-laboratory reagents)? *This criterion does not ask whether a route is "the" correct origin-of-life scenario; competing scenarios are scored on the same basis.*
- **1–3:** Relies on reagents or conditions inconsistent with early Earth (e.g., O₂, purified modern reagents, enzymes, implausibly high concentrations without a concentration mechanism).
- **4–6:** Generally consistent, but one or more steps require conditions or concentrations that are unsupported or only weakly argued.
- **7–8:** Conditions and reagents are consistent with published geochemical constraints; minor assumptions are stated.
- **9–10:** All conditions, catalysts, and concentrations are explicitly tied to published geochemical constraints for the stated environment.

### 7. Novelty of Reactions
Does the network propose non-obvious reaction pathways beyond standard textbook reactions, while remaining chemically defensible?
- **1–3:** Only standard textbook reactions.
- **4–6:** Mostly standard reactions with one non-obvious step or intermediate.
- **7–8:** Several non-obvious but defensible steps, intermediates, or catalytic strategies.
- **9–10:** A substantially novel yet chemically defensible route. (Novelty that is chemically unsound should not score above 6.)

---

## Output Format

For **each config**, provide:

```
### Config [X]

| Criterion                      | Score (1-10) | Justification |
|--------------------------------|-------------|---------------|
| Chemical Feasibility           |             |               |
| Pathway Coherence              |             |               |
| Environmental Consistency      |             |               |
| Reaction Justification         |             |               |
| Network Completeness           |             |               |
| Geochemical Condition Realism  |             |               |
| Novelty of Reactions           |             |               |
| **Total**                      |   **/70**   |               |

**Strengths:** ...
**Weaknesses:** ...
```

After evaluating all six configs, provide:

```
## Final Ranking

| Rank | Config | Total Score | Key Differentiator |
|------|--------|-------------|-------------------|
| 1    |        |             |                   |
| 2    |        |             |                   |
| 3    |        |             |                   |
| 4    |        |             |                   |
| 5    |        |             |                   |
| 6    |        |             |                   |

## Comparative Analysis
[Explain what separates the top-ranked config from the others, and identify any systematic patterns across configs.]
```