# Demo script — "Something Went Wrong" (3:00)

Slides → payment outage → promo crash → behind the scenes.
Speak the **bold lines** verbatim or riff; [bracketed] = actions.

## Pre-flight (start ~10 min before recording)

| When | Do |
|---|---|
| T-10 | `docker compose --profile app up -d` — wait for http://localhost:9000/health = 200 and http://localhost:8000/dk to render. No local agent server needed (Agent Engine). |
| T-10 | Chaos flags: `curl http://localhost:9000/admin/chaos` → need `promo_crash: true`, `payment_timeout: true` (warm-up sets payment_timeout ON anyway). |
| T-6 | **`sh scripts/warmup_payment_problem.sh`** (~2.5 min). The Dynatrace problem opens ~2-3 min later and stays ~15 min past the last failure — your recording window. Re-run it if a take slips past ~12 min. |
| T-3 | Verify problem ACTIVE in Dynatrace Problems (link below): "Payment processing is failing for multiple customers". |
| T-3 | Stage a checkout: storefront → add any product → checkout → fill address (`Nyhavn 1, 1051 Copenhagen, DK`) → pick shipping → STOP at the payment step. Leave this tab here. |
| T-1 | Fresh chat: DevTools console on the storefront tab → `sessionStorage.removeItem("sww-assistant")` → reload. |
| T-1 | Tabs in order: ① slides ② storefront (at payment step) ③ Dynatrace Problems ④ Dynatrace dashboard ⑤ Agent Engine sessions. Full screen, notifications off. |

**Tabs / links**

- Slides: `demo/slides.html` (open in browser, ← → keys)
- Storefront: http://localhost:8000/dk
- Dynatrace Problems: https://yir61923.apps.dynatrace.com/ui/apps/dynatrace.problems
- Dashboard ("Something Went Wrong — store + explainer agent"): https://yir61923.apps.dynatrace.com/ui/apps/dynatrace.dashboards/dashboard/1f67da2b-bb2d-4e93-ad81-1456a6220674
- Agent Engine (sessions appear here, one per explanation phase): https://console.cloud.google.com/vertex-ai/agents/agent-engines/locations/us-west1/agent-engines/4954742442386522112/playground?project=119572966637

## 0:00–0:55 — Slides (6 slides; beats below map 1→slide 2, 2→slide 3, 3→slides 4-5, 4→slide 6 = architecture, then cut straight to the storefront)

1. Modern software, however advance it becomes, realistically we can never account for all the failing cases. more often than not System encountereds a failing case where we must say "something went wrong" to the user. there are multiple challanges, and complications by which not every error can propogate to the frontend. The user is in dellema. is it my fault, is it the system's fault, what should I do? this in turn leaves a negative impression of the platform in user's mind.
2.Solution to this would be to comfort the user with accurate information, which makes it clear who is at fault, and what can mitigate the current situation. rather than a hope of working if tried just a moment later.
3. "let's imagine a scenario of a store application. it's a decently made application recieving significant traffic. the devs have a dynatrace setup for observibility, in place. A user selects things to buy, puts it in a cart, and goes on to make a payment.
something went wrong. please try again later.
the causes can be many, payment service might be down, there might be that went out of stock the moment a user was trying, there can be application wide failure. user doesn't know. in comes our adk built, dynatrace powered agent.
the agent immediately recognizes that some failure has occured. based on the failure info recieved in FE, it creates a initial comforting response to the user. and starts to analyse the failure behind the scences with dynatrace. it probably sees that many payment failures are occuring of a payment provider. it probably sees a inventory issue. it conjures a second response which clearly explains the user what is at fault. with that information user can make a sound decision. and would not feel unsafe using the website.
the system design is simple to understand. our ADK agent recieves an incident from the backend. based on the incident it prepares an initial explaination to calm the user that the problem has been noted. it then using a smart logic, queries dynatrace for related problems. once it is sure of what has happened it sends a transparent response back to the backend.


let's see it with an example - 
  let's say I'm a customer. I picked my things, my address is in, and now I pay. and... something went wrong. this is where a user feels uncomfortable, unsure. our agent takes a few seconds and does a preliminary analysis based on the error information from the application"
  if we go to the cloud agent platform, we can see a new session being created. the agent then  connects to dynatrace MCP server and tries to understand root cause. as we said it can be anything. let's check dynatrace.
- in dynatrace, as an example I have already set up a anomaly detector which detects failures of payment. I triggered some failures manually, and as we can see a problem has been created. our current session will recognize that the payment problem is widespread, and notify the user as so. it could have been a inventory issue, or a user input issue. we comfort the user with the truth. 

let's see one more case.
- sometimes the user can also be at fault.for example, user can give an input which the application didn't account for.
  let's say I have my cart and wish to apply a promo code. I apply SAVE-NULL, and something went wrong. the application crashed due to an unhandled error path in the backend. our agent pops up. it gives an initial message confirming system failure of application."
  behind the scenes it's pulling the exact trace of my request — the failing span, the real stack trace — and checking the problems feed etc.
  we can see our agent spawned in agent platform session, and a span tracked in dynatrace. this one is different, as user is at some fault.
  we also have telemetry for the agent that is spawned, so all can be tracked in one place.
  on the store we can see agent agrees that it's application's fault, at the same time it instructs user that the input is at fault too.
  
  this system can be used across all kinds of applications providing a fallback mechnanism for application mistakes.
  goal being user retention, reducing frustration and being more truthful.
  that's the something went wrong for you.
  thank you.
## Recording against the deployed store (optional, more impressive)

The whole thing also runs off the GCE VM — say "this store is live on a VM in us-west1" instead of localhost:

- Storefront: http://34.82.29.34:8000/dk · backend health: http://34.82.29.34:9000/health
- Warm-up against the VM: `SWW_BASE=http://34.82.29.34:9000 sh scripts/warmup_payment_problem.sh`
- Everything else (Dynatrace tabs, Agent Engine tab, timings) is identical — same tenant, same agent.

## Fallbacks

- **Confirmed verdict slow (>60s)?** Vertex retry-on-429 can add ~20-40s. Visit the dashboard tab early and come back — the bubble will be there.
- **No Dynatrace problem active?** More than ~15 min since warm-up. Re-run the warm-up, wait ~3 min, retake scenario 1.
- **Assistant didn't pop?** Reload — the conversation persists. For a clean retake: `sessionStorage.removeItem("sww-assistant")` + reload.
- **Scenario order matters**: payment first while the problem is warm; promo has no clock on it.

