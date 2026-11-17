/* global process */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env.local' })
const port = Number(process.env.API_PORT || 8787)
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const admin = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = ''
  req.on('data', chunk => {
    raw += chunk
    if (raw.length > 1_000_000) reject(new Error('Request body is too large'))
  })
  req.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('Invalid JSON body')) }
  })
  req.on('error', reject)
})

const requireConfig = () => {
  if (!admin) throw Object.assign(new Error('Server Supabase configuration is missing'), { status: 503 })
}

const authenticate = async (req) => {
  requireConfig()
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Authentication required'), { status: 401 })
  const { data, error } = await admin.auth.getUser(header.slice(7))
  if (error || !data.user) throw Object.assign(new Error('Invalid or expired session'), { status: 401 })
  return data.user
}

const userContext = async (userId) => {
  const [profile, goals, subscription, attempts] = await Promise.all([
    admin.from('profiles').select('id,full_name,estimated_level').eq('id', userId).maybeSingle(),
    admin.from('user_goals').select('goal,daily_minutes,preferred_skills').eq('user_id', userId).maybeSingle(),
    admin.from('subscriptions').select('plan,status,current_period_end').eq('user_id', userId).maybeSingle(),
    admin.from('assessment_attempts').select('id,overall_level,status,completed_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
  ])
  for (const result of [profile, goals, subscription, attempts]) if (result.error) throw Object.assign(new Error(result.error.message), { status: 502 })
  const attemptIds = (attempts.data || []).map(attempt => attempt.id)
  let skillResults = []
  if (attemptIds.length) {
    const result = await admin.from('skill_results').select('attempt_id,skill,level,score,evidence').in('attempt_id', attemptIds)
    if (result.error) throw Object.assign(new Error(result.error.message), { status: 502 })
    skillResults = result.data || []
  }
  return { profile: profile.data, goals: goals.data, subscription: subscription.data, attempts: attempts.data || [], skillResults }
}

const answerKey = (prompt) => prompt?.correctAnswer ?? prompt?.correct_answer ?? prompt?.answer ?? null
const publicPrompt = (prompt) => {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return prompt
  const copy = { ...prompt }
  delete copy.correctAnswer
  delete copy.correct_answer
  delete copy.answer
  return copy
}

const tutor = async (req, res) => {
  const user = await authenticate(req)
  const body = await readBody(req)
  const input = typeof body.input === 'string' ? body.input.trim() : ''
  const mode = ['tutor', 'writing-correction', 'recommendations'].includes(body.mode) ? body.mode : 'tutor'
  if (!input || input.length > 4000) return json(res, 400, { error: 'A message between 1 and 4000 characters is required' })
  if (!process.env.AI_API_KEY || !process.env.AI_API_URL || !process.env.AI_MODEL) return json(res, 503, { error: 'AI provider is not configured on the server. Set AI_API_KEY, AI_API_URL, and AI_MODEL.' })
  const context = await userContext(user.id)
  const paid = ['premium', 'pro'].includes(context.subscription?.plan) && context.subscription?.status === 'active'
  const since = new Date(); since.setUTCHours(0, 0, 0, 0)
  const usage = await admin.from('tutor_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', body.conversationId || '').eq('role', 'assistant').gte('created_at', since.toISOString())
  if (usage.error && usage.error.code !== 'PGRST116') throw Object.assign(new Error(usage.error.message), { status: 502 })
  const limit = paid ? 200 : 20
  if ((usage.count || 0) >= limit) return json(res, 429, { error: `Daily tutor limit reached (${limit} messages).` })

  let conversationId = body.conversationId
  if (conversationId) {
    const conversation = await admin.from('tutor_conversations').select('id').eq('id', conversationId).eq('user_id', user.id).maybeSingle()
    if (conversation.error) throw Object.assign(new Error(conversation.error.message), { status: 502 })
    if (!conversation.data) return json(res, 404, { error: 'Conversation not found' })
  } else {
    const conversation = await admin.from('tutor_conversations').insert({ user_id: user.id, title: input.slice(0, 80) }).select('id').single()
    if (conversation.error) throw Object.assign(new Error(conversation.error.message), { status: 502 })
    conversationId = conversation.data.id
  }
  const history = await admin.from('tutor_messages').select('role,content').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(12)
  if (history.error) throw Object.assign(new Error(history.error.message), { status: 502 })
  await admin.from('tutor_messages').insert({ conversation_id: conversationId, role: 'user', content: input })
  const system = `You are LEVELUP English Tutor. Give accurate, encouraging, level-appropriate English instruction. User context: ${JSON.stringify(context)}. Mode: ${mode}. For writing-correction, return corrected text, a concise list of mistakes with explanations, and a score out of 100. For recommendations, return a prioritized study plan. Do not claim to have performed actions you did not perform.`
  const response = await fetch(process.env.AI_API_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.AI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL, messages: [{ role: 'system', content: system }, ...history.data.reverse(), { role: 'user', content: input }], temperature: 0.3 }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return json(res, response.status === 429 ? 429 : 502, { error: `AI provider request failed (${response.status}).` })
  const payload = await response.json()
  const answer = payload.choices?.[0]?.message?.content
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 20_000) return json(res, 502, { error: 'AI provider returned an invalid response.' })
  const saved = await admin.from('tutor_messages').insert({ conversation_id: conversationId, role: 'assistant', content: answer }).select('id,created_at').single()
  if (saved.error) throw Object.assign(new Error(saved.error.message), { status: 502 })
  return json(res, 200, { conversationId, message: { id: saved.data.id, role: 'assistant', content: answer, createdAt: saved.data.created_at }, usage: { used: (usage.count || 0) + 1, limit } })
}

const startExam = async (req, res) => {
  const user = await authenticate(req)
  const body = await readBody(req)
  const assessmentQuery = body.assessmentId
    ? admin.from('assessments').select('id,title').eq('id', body.assessmentId).eq('published', true).single()
    : admin.from('assessments').select('id,title').eq('is_placement', true).eq('published', true).limit(1).single()
  const assessment = await assessmentQuery
  if (assessment.error || !assessment.data) return json(res, 404, { error: 'No published assessment is available.' })
  const questions = await admin.from('questions').select('id,skill,question_type,prompt,cefr_target,position').eq('assessment_id', assessment.data.id).order('position')
  if (questions.error) throw Object.assign(new Error(questions.error.message), { status: 502 })
  if (!questions.data?.length) return json(res, 409, { error: 'The assessment has no questions.' })
  const durationSeconds = Math.min(Math.max(Number(body.durationSeconds) || 900, 60), 7200)
  const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString()
  const items = questions.data.map(question => ({ attempt_id: null, question_id: question.id, position: question.position, prompt: publicPrompt(question.prompt), correct_answer: answerKey(question.prompt), skill: question.skill, question_type: question.question_type, cefr_target: question.cefr_target }))
  if (items.some(item => item.correct_answer === null && ['multiple_choice', 'true_false', 'fill_blank', 'ordering', 'error_detection', 'sentence_correction'].includes(item.question_type))) return json(res, 409, { error: 'This assessment is not fully configured for server-side scoring.' })
  const attempt = await admin.from('assessment_attempts').insert({ user_id: user.id, assessment_id: assessment.data.id, status: 'in_progress', expires_at: expiresAt }).select('id,started_at,expires_at').single()
  if (attempt.error) throw Object.assign(new Error(attempt.error.message), { status: 502 })
  items.forEach(item => { item.attempt_id = attempt.data.id })
  const saved = await admin.from('exam_attempt_items').insert(items)
  if (saved.error) throw Object.assign(new Error(saved.error.message), { status: 502 })
  return json(res, 201, { attemptId: attempt.data.id, assessment: assessment.data, startedAt: attempt.data.started_at, expiresAt: attempt.data.expires_at, questions: items.map(item => ({ questionId: item.question_id, position: item.position, prompt: item.prompt, skill: item.skill, questionType: item.question_type, cefrTarget: item.cefr_target })) })
}

const submitExam = async (req, res) => {
  const user = await authenticate(req)
  const body = await readBody(req)
  if (!body.attemptId || !Array.isArray(body.answers)) return json(res, 400, { error: 'attemptId and answers are required' })
  const attempt = await admin.from('assessment_attempts').select('id,user_id,status,started_at,expires_at,assessment_id').eq('id', body.attemptId).eq('user_id', user.id).single()
  if (attempt.error || !attempt.data) return json(res, 404, { error: 'Attempt not found' })
  if (attempt.data.status !== 'in_progress') return json(res, 409, { error: 'This attempt has already been submitted.' })
  const items = await admin.from('exam_attempt_items').select('question_id,skill,correct_answer').eq('attempt_id', body.attemptId).order('position')
  if (items.error) throw Object.assign(new Error(items.error.message), { status: 502 })
  const submitted = new Map(body.answers.map(answer => [answer.questionId, answer.answer]))
  const expired = Date.now() >= new Date(attempt.data.expires_at).getTime()
  const scored = items.data.map(item => ({ ...item, answer: submitted.get(item.question_id), score: JSON.stringify(submitted.get(item.question_id)) === JSON.stringify(item.correct_answer) ? 100 : 0 }))
  const total = scored.length ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : 0
  const submittedAnswers = await admin.from('answers').insert(scored.map(item => ({ attempt_id: body.attemptId, question_id: item.question_id, answer: item.answer ?? null, score: item.score })))
  if (submittedAnswers.error) throw Object.assign(new Error(submittedAnswers.error.message), { status: submittedAnswers.error.code === '23505' ? 409 : 502 })
  const status = expired ? 'expired' : 'submitted'
  const updated = await admin.from('assessment_attempts').update({ status, completed_at: new Date().toISOString() }).eq('id', body.attemptId).eq('status', 'in_progress').select('id').single()
  if (updated.error || !updated.data) return json(res, 409, { error: 'Attempt was already finalized.' })
  const passed = !expired && total >= 70
  let certificate = null
  if (passed) {
    const issued = await admin.from('certificates').insert({ certificate_number: `LU-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`, user_id: user.id, assessment_id: attempt.data.assessment_id, title: 'LEVELUP English assessment completion' }).select('certificate_number,verification_token,issued_at,title').single()
    if (issued.error && issued.error.code !== '23505') throw Object.assign(new Error(issued.error.message), { status: 502 })
    certificate = issued.data
  }
  return json(res, 200, { attemptId: body.attemptId, status, score: total, passed, certificate, skillScores: Object.values(scored.reduce((result, item) => { result[item.skill] ||= []; result[item.skill].push(item.score); return result }, {})).map(scores => scores.reduce((sum, score) => sum + score, 0) / scores.length) })
}

const paymentStatus = async (req, res) => {
  await authenticate(req)
  if (!process.env.D17_API_URL || !process.env.D17_API_KEY || !process.env.D17_MERCHANT_ID) return json(res, 503, { error: 'D17 merchant credentials and an approved API endpoint are not configured. No payment was attempted.' })
  return json(res, 501, { error: 'D17 endpoint contract requires merchant-specific approval and has not been configured.' })
}

const createManualPayment = async (req, res) => {
  const user = await authenticate(req)
  const body = await readBody(req)
  const amount = Number(body.amount)
  if (!body.invoiceId || !Number.isFinite(amount) || amount <= 0 || !['premium', 'pro'].includes(body.plan)) return json(res, 400, { error: 'invoiceId, plan, and a positive amount are required' })
  const transaction = await admin.from('payment_transactions').insert({ user_id: user.id, provider: 'd17-manual', invoice_id: body.invoiceId, amount, currency: 'TND', status: 'pending' }).select('id,invoice_id,status,amount,currency').single()
  if (transaction.error) return json(res, transaction.error.code === '23505' ? 409 : 502, { error: transaction.error.code === '23505' ? 'Invoice already exists.' : transaction.error.message })
  return json(res, 201, transaction.data)
}

const verifyManualPayment = async (req, res) => {
  const user = await authenticate(req)
  const profile = await admin.from('profiles').select('role').eq('id', user.id).single()
  if (profile.error || profile.data?.role !== 'admin') return json(res, 403, { error: 'Admin access required.' })
  const body = await readBody(req)
  if (!body.transactionId || !body.userId || !body.plan || !body.providerTransactionId) return json(res, 400, { error: 'transactionId, userId, plan, and providerTransactionId are required' })
  const transaction = await admin.from('payment_transactions').select('id,user_id,status').eq('id', body.transactionId).single()
  if (transaction.error || !transaction.data) return json(res, 404, { error: 'Payment transaction not found.' })
  if (transaction.data.status === 'verified') return json(res, 409, { error: 'Payment is already verified.' })
  const updated = await admin.from('payment_transactions').update({ status: 'verified', provider_transaction_id: body.providerTransactionId, verified_at: new Date().toISOString(), raw_status: { verifiedBy: user.id } }).eq('id', body.transactionId).eq('status', 'pending').select('id,status').single()
  if (updated.error) return json(res, updated.error.code === '23505' ? 409 : 502, { error: updated.error.message })
  const subscription = await admin.from('subscriptions').upsert({ user_id: transaction.data.user_id, plan: body.plan, provider: 'd17-manual', provider_subscription_id: body.providerTransactionId, status: 'active' }, { onConflict: 'user_id' }).select('user_id,plan,status').single()
  if (subscription.error) throw Object.assign(new Error(subscription.error.message), { status: 502 })
  return json(res, 200, { transaction: updated.data, subscription: subscription.data })
}

const handler = async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
    if (req.url === '/api/tutor') return await tutor(req, res)
    if (req.url === '/api/exams/start') return await startExam(req, res)
    if (req.url === '/api/exams/submit') return await submitExam(req, res)
    if (req.url === '/api/payments/start') return await paymentStatus(req, res)
    if (req.url === '/api/payments/manual/create') return await createManualPayment(req, res)
    if (req.url === '/api/payments/manual/verify') return await verifyManualPayment(req, res)
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, error.status || 500, { error: error.message || 'Internal server error' })
  }
}

http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`LEVELUP API listening on http://127.0.0.1:${port}`))
