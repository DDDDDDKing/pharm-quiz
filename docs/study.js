// Review selection is deterministic and uses the learner's own answer history.
export function done(state, id) {
  return !!state.rec[id]?.a || !!state.marked?.[id];
}

export function matches(state, question, filter) {
  const id = question.id;
  if (filter === 'unseen') return !done(state,id);
  if (filter === 'done') return done(state,id);
  if (filter === 'wrong') return state.wrong.includes(id);
  if (filter === 'everwrong') return (state.rec[id]?.a || 0) > (state.rec[id]?.c || 0);
  if (filter === 'fav') return state.fav.includes(id);
  if (filter === 'notes') return !!state.notes?.[id]?.trim();
  if (filter === 'mastered') return !!state.mastered?.[id];
  return true;
}

export function reviewQuestions(questions, state, count, now = Date.now()) {
  return questions.filter(q => !state.mastered?.[q.id]).map(question => {
    const record = state.rec[question.id];
    const age = record ? Math.max(0,(now-record.t)/86400000) : 0;
    const wrong = state.wrong.includes(question.id);
    const mistakes = record ? record.a-record.c : 0;
    const score = (wrong ? 100 : 0) + (record?.w ? 30 : 0)
      + (record ? 25 * mistakes / record.a : 20)
      + Math.min(age,30) + (state.fav.includes(question.id) ? 10 : 0);
    return {question,score};
  }).sort((a,b) => b.score-a.score || a.question.sec-b.question.sec || a.question.num-b.question.num)
    .slice(0,count).map(item => item.question.id);
}
