// For utilities the phone connects to (Phone Drop, Phone Mirror): warns when Windows or a
// third-party firewall is set up in a way that stops devices on the Wi-Fi from reaching this PC.
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import { core, hasBridge, type NetworkProblem } from '@/lib/bridge'
import { useIsActive } from '@/lib/active'
import { Button, Notice, Row } from './ui'

export function LanAdvisor() {
  const active = useIsActive()
  const [problems, setProblems] = useState<NetworkProblem[]>([])
  const [checking, setChecking] = useState(false)

  const check = useCallback(async (fresh: boolean) => {
    if (!hasBridge) return
    setChecking(true)
    try {
      setProblems((await core.networkCheck(fresh)).problems)
    } catch {
      setProblems([])
    } finally {
      setChecking(false)
    }
  }, [])

  // re-check whenever the utility comes back on screen: the user may just have fixed it
  useEffect(() => {
    if (active) check(false)
  }, [active, check])

  if (problems.length === 0) return null
  return (
    <>
      {problems.map((problem) => (
        <Notice key={problem.id} tone="warn" icon={ShieldAlert} title={problem.title}>
          {problem.detail}
          {problem.id === 'public-network' && (
            <Row gap={6} className="lan-advisor__actions">
              {problem.action && (
                <Button size="sm" onClick={() => core.openExternal(problem.action!.url)}>
                  {problem.action.label}
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={RefreshCw} loading={checking} onClick={() => check(true)}>
                Check again
              </Button>
            </Row>
          )}
        </Notice>
      ))}
    </>
  )
}
