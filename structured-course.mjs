import { buildStructuredCourse as reviewedCourse, structuredMetadata as reviewedMetadata } from './full-course.mjs'
import { loadPlannedCourse } from './course-planner.mjs'
export { gradeUnit } from './full-course.mjs'

export function buildStructuredCourse(document, directory) {
  const planned = loadPlannedCourse(document, directory)
  if (planned?.status === 'ready') return planned.course
  if (planned) return null
  return reviewedCourse(document)
}

export function structuredMetadata(document, directory) {
  const planned = loadPlannedCourse(document, directory)
  if (!planned) return reviewedMetadata(document) || (document?.requiresPlanning ? { structured: false, planningStatus: 'queued' } : null)
  if (planned.status !== 'ready') return { structured: false, planningStatus: planned.status, planningCompleted: planned.completed, planningTotal: planned.total, ...(planned.error ? { structuredError: planned.error } : {}) }
  if (!planned.course) return { structured: false, isGuide: true, planningStatus: 'ready', planningOrigin: 'ai-import', topic: 'ข้อมูลประกอบหลักสูตร', preview: planned.summary.slice(0, 250) }
  const plan = planned.course
  return { structured: true, planningStatus: 'ready', planningOrigin: 'ai-import', structuredTitle: plan.title, structuredUnits: plan.units.length, structuredRevision: plan.revision,
    topic: plan.units[0].title, preview: plan.units[0].examples.slice(0, 2).map(example => example.target).join(' · '), goals: plan.goalCoverage.length, vocabulary: plan.contentStats.vocabulary, sourceSections: plan.sourceSections.length }
}
