export function scorePlan(plan, checks) {
  const steps=plan.steps
  return checks.map(check=>{
    const match=s=>s.action===check.action && (check.item===undefined||s.item===check.item) && (check.count===undefined||s.count===check.count)
    let passed
    switch(check.type){
      case 'action': passed=steps.some(match);break
      case 'no-action': passed=!steps.some(match);break
      case 'no-steps': passed=steps.length===0;break
      case 'acquire-or-gather': passed=steps.some(s=>['acquire','gather'].includes(s.action)&&s.item===check.item&&s.count===check.count);break
      case 'save-before-return': {
        const save=steps.findIndex(s=>s.action==='remember')
        const ret=steps.findIndex(s=>s.action==='return'&&save>=0&&s.name===steps[save].name)
        const acquire=steps.findIndex(s=>s.action==='acquire')
        passed=save>=0&&acquire>save&&ret>acquire;break
      }
      default:throw new Error(`Unknown check: ${check.type}`)
    }
    return {...check,passed}
  })
}
