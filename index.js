import express from "express";
import axios from "axios";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// Allow iframe embedding in LeadSquared
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

/* =====================================================
   CONFIGURATION
===================================================== */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LeadSquared CRM
const LS_BASE_URL = process.env.LS_BASE_URL || "https://api-us11.leadsquared.com/v2";
const LS_ACCESS_KEY = process.env.LS_ACCESS_KEY;
const LS_SECRET_KEY = process.env.LS_SECRET_KEY;

// Mavis Data Warehouse
const MAVIS_BASE_URL = process.env.MAVIS_BASE_URL; // e.g. https://mavis-rest-us11.leadsquared.com/api/db{dbId}/tab{tabId}
const MAVIS_API_KEY = process.env.MAVIS_API_KEY;
const MAVIS_ORG_CODE = process.env.MAVIS_ORG_CODE || "78807";

// We'll have multiple Mavis tables — store their tab URLs
const MAVIS_TABLES = {
  students: process.env.MAVIS_TAB_STUDENTS,         // main student enrollment table
  courses: process.env.MAVIS_TAB_COURSES,            // course_enrollment_detail
  financial_aid: process.env.MAVIS_TAB_FINANCIAL_AID // financial_aid_disbursement
};

/* =====================================================
   EXTERNAL DATA (Static JSON — loaded at startup)
   These live as JSON files or inline. For demo, inline.
===================================================== */

const MARKETING_CAMPAIGNS = [
  { campaign_name: "Medical Assisting — Facebook Ads", platform: "Facebook Ads", program: "Medical Assisting", spend: 48000, leads_generated: 156, cost_per_lead: 307.69, started: 18, cost_per_start: 2666.67, period: "Fall" },
  { campaign_name: "Business — Pay per Click Ads", platform: "Pay per Click Ads", program: "Business", spend: 32000, leads_generated: 210, cost_per_lead: 152.38, started: 31, cost_per_start: 1032.26, period: "Fall" },
  { campaign_name: "HVAC Technology — Facebook Ads", platform: "Facebook Ads", program: "HVAC Technology", spend: 28000, leads_generated: 98, cost_per_lead: 285.71, started: 12, cost_per_start: 2333.33, period: "Fall" },
  { campaign_name: "Cosmetology — Inbound Email", platform: "Inbound Email", program: "Cosmetology", spend: 5200, leads_generated: 87, cost_per_lead: 59.77, started: 22, cost_per_start: 236.36, period: "Fall" },
  { campaign_name: "Automotive Technology — Social Media", platform: "Social Media", program: "Automotive Technology", spend: 15000, leads_generated: 134, cost_per_lead: 111.94, started: 14, cost_per_start: 1071.43, period: "Fall" },
  { campaign_name: "Brand Awareness — Pay per Click Ads", platform: "Pay per Click Ads", program: "General", spend: 22000, leads_generated: 320, cost_per_lead: 68.75, started: 0, cost_per_start: null, period: "Fall" },
  { campaign_name: "Open House — Event / Webinar", platform: "Event / Webinar", program: "General", spend: 3500, leads_generated: 45, cost_per_lead: 77.78, started: 15, cost_per_start: 233.33, period: "Spring" },
  { campaign_name: "Welding — Trade Show", platform: "Trade Show", program: "Welding", spend: 8000, leads_generated: 62, cost_per_lead: 129.03, started: 20, cost_per_start: 400.00, period: "Spring" },
];

// Placeholder for IPEDS / BLS if needed later
const IPEDS_BENCHMARKS = {}; // TBD
const LABOR_MARKET = {};     // TBD

/* =====================================================
   REPORT TYPE DEFINITIONS
===================================================== */

const REPORT_TYPES = [
  { id: "enrollment_funnel", name: "Admissions Funnel", description: "Pipeline from Inquiry → Started with conversion rates", data_sources: ["crm"] },
  { id: "campus_comparison", name: "Campus Comparison", description: "Side-by-side metrics across campuses", data_sources: ["crm"] },
  { id: "source_roi", name: "Source ROI Analysis", description: "Lead source performance and marketing cost-per-start", data_sources: ["crm", "external"] },
  { id: "counselor_performance", name: "Admissions Rep Performance", description: "Conversion rates and activity by admissions rep", data_sources: ["crm"] },
  { id: "program_performance", name: "Program Performance", description: "Starts, retention, and completion rates by program", data_sources: ["crm", "mavis"] },
  { id: "course_dropoff", name: "Program Drop Analysis", description: "Withdrawal and drop rates by program", data_sources: ["mavis"] },
  { id: "financial_overview", name: "Financial Overview", description: "Tuition balances and financial aid disbursement", data_sources: ["mavis"] },
  { id: "at_risk_students", name: "At-Risk Students", description: "Students with low engagement, attendance issues, or at risk of not starting", data_sources: ["crm", "mavis"] },
  { id: "marketing_performance", name: "Marketing Performance", description: "Campaign spend, CPL, cost per start, and ROI by channel", data_sources: ["external"] },
  { id: "general", name: "General Report", description: "Freeform report using all available data when no specific type matches", data_sources: ["crm", "mavis", "external"] },
];

/* =====================================================
   STEP 1: INTENT CLASSIFICATION
===================================================== */

async function classifyIntent(userPrompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `You are a report intent classifier for a career school admissions CRM. Given a user's natural language prompt, classify it into a report type and extract filters.

The user base spans career education institutions — for-profit career schools, beauty/cosmetology academies, healthcare training programs, culinary institutes, trade/technical schools, and some traditional universities. Use career school terminology: "starts" (not enrollments), "programs" (not majors/degrees), "admissions reps" (not counselors), "campus" for multi-location context, "completion rate" (not graduation rate), "program drops" (not course drop-offs), "term" (not semester).

Available report types: ${REPORT_TYPES.map(r => `${r.id} (${r.name})`).join(", ")}

If the prompt doesn't clearly match any specific type, use "general".

Example queries and mappings:
- "Inquiry to start funnel" → enrollment_funnel
- "Admissions rep performance" → counselor_performance
- "Cost per start by channel" → source_roi
- "Program drops by campus" → course_dropoff
- "Start rate by lead source" → source_roi
- "Speed to contact" → counselor_performance
- "Attendance trends by program" → program_performance

Return JSON only:
{
  "report_type": "one of the report type IDs",
  "filters": {
    "campus": "California Campus" | "Dallas Campus" | "Michigan Campus" | "New York Campus" | "Washington Campus" | null,
    "program": "Accounting" | "HVAC Technology" | "Medical Assisting" | "Cosmetology" | "Business" | "Automotive Technology" | "Welding" | "Dental Assisting" | "IT" | null,
    "term": "Fall" | "Spring" | "Summer" | null,
    "source": "Social Media" | "Inbound Email" | "Inbound Phone call" | "Pay per Click Ads" | "Trade Show" | "B2B Referral" | "Website Form" | "Facebook Ads" | "Chatbot" | "Event / Webinar" | "Website" | null,
    "counselor": null,
    "date_range": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } | null
  },
  "user_intent_summary": "one sentence describing what the user wants"
}`
      },
      { role: "user", content: userPrompt }
    ],
    response_format: { type: "json_object" }
  });

  return JSON.parse(response.choices[0].message.content);
}

/* =====================================================
   STEP 2: DATA FETCHERS
===================================================== */

// --- LeadSquared CRM: Fetch leads via Advanced Search ---
// Actual CRM dropdown values
const CRM_STAGES = [
  "New Prospect", "Engagement Initiated", "Application Pending",
  "Application Completed", "Enrolled", "Disqualified", "Invalid", "Attempting Contact"
];

const COLUMNS_CSV = [
  "ProspectID", "FirstName", "LastName", "EmailAddress",
  "ProspectStage", "Source", "CreatedOn", "ModifiedOn",
  "EngagementScore", "Score", "LeadType",
  "mx_Campus", "mx_Program_Interest", "mx_Program_Level",
  "OwnerId", "mx_Intended_Intake_Term",
  "mx_Application_Submitted", "mx_Financial_Aid_Status",
  "mx_GPA_Range", "mx_Enrollment_Deposit_Paid",
  "mx_Readiness_Score", "mx_Readiness_Bucket",
  "mx_Engagement_Readiness", "mx_Stage_Entered_On",
  "mx_Offer_Given_Date", "mx_Gender", "mx_US_States",
  "mx_Preferred_Language"
].join(",");

// Helper: flatten LeadPropertyList into flat object
function flattenLead(lead) {
  const props = {};
  if (lead.LeadPropertyList) {
    lead.LeadPropertyList.forEach(p => { props[p.Attribute] = p.Value; });
  }
  return { ...lead, ...props };
}

// Fetch students for a single stage
async function fetchStudentsByStage(stage) {
  try {
    const allForStage = [];
    let pageIndex = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.post(
        `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
        {
          Parameter: {
            LookupName: "ProspectStage",
            LookupValue: stage,
            SqlOperator: "="
          },
          Columns: { Include_CSV: COLUMNS_CSV },
          Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
          Paging: { PageIndex: pageIndex, PageSize: 200 }
        },
        {
          params: { accessKey: LS_ACCESS_KEY, secretKey: LS_SECRET_KEY },
          headers: { "Content-Type": "application/json" }
        }
      );

      const rawLeads = Array.isArray(response.data)
        ? response.data
        : response.data?.Leads || [];

      const flattened = rawLeads.map(flattenLead);
      const students = flattened.filter(l => l.LeadType === "OT_2");
      allForStage.push(...students);

      if (rawLeads.length < 200) {
        hasMore = false;
      } else {
        pageIndex++;
        if (pageIndex > 10) hasMore = false;
      }
    }

    console.log(`  Stage "${stage}": ${allForStage.length} students`);
    return allForStage;
  } catch (err) {
    console.error(`  ❌ Stage "${stage}" fetch error:`, err.response?.data || err.message);
    return [];
  }
}

// Main: fetch all student leads across all stages
async function fetchCRMLeads(filters = {}) {
  try {
    console.log("📋 CRM: Fetching students by stage...");
    let allLeads = [];

    for (const stage of CRM_STAGES) {
      const students = await fetchStudentsByStage(stage);
      allLeads.push(...students);
    }

    console.log(`📋 CRM: Total ${allLeads.length} student leads (OT_2)`);

    // Apply filters in-memory
    let filtered = allLeads;
    if (filters.campus) {
      filtered = filtered.filter(l => l.mx_Campus === filters.campus);
    }
    if (filters.program) {
      filtered = filtered.filter(l => l.mx_Program_Interest === filters.program);
    }
    if (filters.source) {
      filtered = filtered.filter(l => l.Source === filters.source);
    }
    if (filters.term) {
      filtered = filtered.filter(l => l.mx_Intended_Intake_Term === filters.term);
    }
    if (filters.counselor) {
      filtered = filtered.filter(l => l.OwnerId === filters.counselor);
    }

    return filtered;
  } catch (err) {
    console.error("❌ CRM fetch error:", err.response?.data || err.message);
    return [];
  }
}

// --- Mavis: Bulk fetch from a table ---
async function fetchMavisTable(tableUrl) {
  if (!tableUrl) {
    console.log("⚠️ Mavis table URL not configured, skipping");
    return [];
  }

  try {
    const response = await axios.post(
      `${tableUrl}/rows/query?orgcode=${MAVIS_ORG_CODE}`,
      {},
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": MAVIS_API_KEY
        }
      }
    );

    const rows = response.data?.Data || [];
    console.log(`📊 Mavis: Fetched ${rows.length} rows from ${tableUrl.split("/").pop()}`);
    return rows;
  } catch (err) {
    console.error("❌ Mavis fetch error:", err.response?.data || err.message);
    return [];
  }
}

// --- External: Marketing campaign data ---
function getMarketingData(filters = {}) {
  let data = [...MARKETING_CAMPAIGNS];
  if (filters.program) {
    data = data.filter(c => c.program === filters.program || c.program === "General");
  }
  if (filters.source) {
    data = data.filter(c => c.platform.toLowerCase().includes(filters.source.toLowerCase()));
  }
  return data;
}

/* =====================================================
   STEP 2B: DATA AGGREGATION
===================================================== */

function aggregateLeadsByField(leads, field) {
  const counts = {};
  leads.forEach(lead => {
    const val = lead[field] || "Unknown";
    counts[val] = (counts[val] || 0) + 1;
  });
  return counts;
}

function buildFunnelData(leads) {
  // Dynamically build funnel from actual stage values
  const stageCounts = {};
  leads.forEach(lead => {
    const stage = lead.ProspectStage || "Unknown";
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
  });

  // Preferred order (adjust based on actual LSQ stage configuration)
  const preferredOrder = [
    "New Prospect", "Attempting Contact", "Engagement Initiated",
    "Application Pending", "Application Completed",
    "Enrolled", "Disqualified", "Invalid"
  ];

  // Build ordered funnel from stages that actually have data
  const orderedStages = preferredOrder.filter(s => stageCounts[s] > 0);
  // Add any stages not in preferred order
  Object.keys(stageCounts).forEach(s => {
    if (!orderedStages.includes(s) && s !== "Unknown") orderedStages.push(s);
  });

  const funnelWithRates = {};
  let prev = null;
  for (const stage of orderedStages) {
    funnelWithRates[stage] = {
      count: stageCounts[stage] || 0,
      conversion_from_previous: prev !== null && prev > 0
        ? (((stageCounts[stage] || 0) / prev) * 100).toFixed(1) + "%"
        : "—"
    };
    prev = stageCounts[stage] || 0;
  }

  return funnelWithRates;
}

function buildCounselorMetrics(leads) {
  const counselors = {};
  leads.forEach(lead => {
    const c = lead.OwnerId || "Unassigned";
    if (!counselors[c]) {
      counselors[c] = { total: 0, enrolled: 0, stages: {} };
    }
    counselors[c].total++;
    const stage = lead.ProspectStage || "Unknown";
    counselors[c].stages[stage] = (counselors[c].stages[stage] || 0) + 1;
    if (stage === "Enrolled") counselors[c].enrolled++;
  });

  // Calculate conversion rate
  Object.keys(counselors).forEach(c => {
    counselors[c].conversion_rate = counselors[c].total > 0
      ? ((counselors[c].enrolled / counselors[c].total) * 100).toFixed(1) + "%"
      : "0%";
  });

  return counselors;
}

function identifyAtRiskLeads(leads) {
  const now = new Date();
  const atRisk = [];

  leads.forEach(lead => {
    const reasons = [];
    // Use ModifiedOn as proxy for last activity
    const lastActivity = lead.ModifiedOn ? new Date(lead.ModifiedOn) : null;
    const daysSinceActivity = lastActivity ? Math.floor((now - lastActivity) / (1000 * 60 * 60 * 24)) : null;
    const engagementScore = parseInt(lead.EngagementScore) || 0;
    const readinessScore = parseInt(lead.mx_Readiness_Score) || 0;

    if (daysSinceActivity && daysSinceActivity > 21) {
      reasons.push(`No activity in ${daysSinceActivity} days`);
    }
    if (engagementScore < 20) {
      reasons.push(`Low engagement score: ${engagementScore}`);
    }
    if (readinessScore > 0 && readinessScore < 30) {
      reasons.push(`Low readiness score: ${readinessScore}`);
    }
    // Accepted but no enrollment agreement signed
    const stage = lead.ProspectStage;
    if (stage === "Application Completed" && lead.mx_Enrollment_Deposit_Paid !== "Yes") {
      reasons.push("Application completed but enrollment agreement not signed");
    }

    if (reasons.length > 0) {
      atRisk.push({
        name: `${lead.FirstName || ""} ${lead.LastName || ""}`.trim(),
        prospect_id: lead.ProspectID,
        stage: stage,
        counselor: lead.OwnerId || "Unassigned",
        campus: lead.mx_Campus || "Unknown",
        program: lead.mx_Program_Interest || "Unknown",
        risk_reasons: reasons,
        days_since_activity: daysSinceActivity,
        engagement_score: engagementScore,
        readiness_score: readinessScore
      });
    }
  });

  return atRisk.sort((a, b) => b.risk_reasons.length - a.risk_reasons.length);
}

/* =====================================================
   STEP 2C: ASSEMBLE DATA CONTEXT FOR REPORT TYPE
===================================================== */

async function assembleDataContext(reportType, filters) {
  const context = {
    data_sources_used: [],
    crm_data: null,
    mavis_data: null,
    external_data: null,
    aggregations: {}
  };

  // Most report types need CRM data
  const crmTypes = ["enrollment_funnel", "campus_comparison", "source_roi", "counselor_performance", "program_performance", "at_risk_students", "general"];
  if (crmTypes.includes(reportType)) {
    const leads = await fetchCRMLeads(filters);
    context.crm_data = leads;
    context.data_sources_used.push({ name: "LeadSquared CRM", badge: "CRM" });

    // Pre-compute common aggregations
    context.aggregations.total_leads = leads.length;
    context.aggregations.by_stage = aggregateLeadsByField(leads, "ProspectStage");
    context.aggregations.by_campus = aggregateLeadsByField(leads, "mx_Campus");
    context.aggregations.by_program = aggregateLeadsByField(leads, "mx_Program_Interest");
    context.aggregations.by_source = aggregateLeadsByField(leads, "Source");
    context.aggregations.by_counselor = aggregateLeadsByField(leads, "OwnerId");
    context.aggregations.by_term = aggregateLeadsByField(leads, "mx_Intended_Intake_Term");
    context.aggregations.by_gpa = aggregateLeadsByField(leads, "mx_GPA_Range");
    context.aggregations.by_aid_status = aggregateLeadsByField(leads, "mx_Financial_Aid_Status");
    context.aggregations.funnel = buildFunnelData(leads);
    context.aggregations.counselor_metrics = buildCounselorMetrics(leads);

    if (reportType === "at_risk_students") {
      context.aggregations.at_risk = identifyAtRiskLeads(leads);
    }
  }

  // Mavis data
  const mavisTypes = ["course_dropoff", "financial_overview", "program_performance", "at_risk_students", "general"];
  if (mavisTypes.includes(reportType)) {
    if (MAVIS_TABLES.students) {
      const students = await fetchMavisTable(MAVIS_TABLES.students);
      context.mavis_data = { students };
      context.data_sources_used.push({ name: "Mavis SIS", badge: "SIS" });
    }
    if (reportType === "course_dropoff" && MAVIS_TABLES.courses) {
      const courses = await fetchMavisTable(MAVIS_TABLES.courses);
      context.mavis_data = { ...(context.mavis_data || {}), courses };
    }
    if (reportType === "financial_overview" && MAVIS_TABLES.financial_aid) {
      const aid = await fetchMavisTable(MAVIS_TABLES.financial_aid);
      context.mavis_data = { ...(context.mavis_data || {}), financial_aid: aid };
    }
  }

  // External data
  const externalTypes = ["source_roi", "marketing_performance", "general"];
  if (externalTypes.includes(reportType)) {
    context.external_data = { marketing_campaigns: getMarketingData(filters) };
    context.data_sources_used.push({ name: "Marketing Campaign Data", badge: "External" });
  }

  return context;
}

/* =====================================================
   STEP 3: REPORT GENERATION (OpenAI with real data)
===================================================== */

async function generateReport(userPrompt, intent, dataContext) {
  // Build a concise data summary for the LLM (don't send raw leads)
  const dataSummary = {
    data_sources: dataContext.data_sources_used.map(s => s.name),
    total_leads: dataContext.aggregations.total_leads || 0,
    aggregations: dataContext.aggregations,
    mavis_data: dataContext.mavis_data
      ? {
          students_count: dataContext.mavis_data.students?.length || 0,
          courses_count: dataContext.mavis_data.courses?.length || 0,
          financial_aid_count: dataContext.mavis_data.financial_aid?.length || 0,
          // Send first 50 rows max as sample
          students_sample: (dataContext.mavis_data.students || []).slice(0, 50),
          courses_sample: (dataContext.mavis_data.courses || []).slice(0, 50),
          financial_aid_sample: (dataContext.mavis_data.financial_aid || []).slice(0, 50),
        }
      : null,
    external_data: dataContext.external_data
  };

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You are Quill AI, an enterprise reporting intelligence agent for career school admissions operations.
You generate data-driven reports based on REAL data provided to you. Never fabricate numbers — use only the data context given.

IMPORTANT — CAREER SCHOOL TERMINOLOGY:
You are writing for career education institutions — for-profit career schools, beauty/cosmetology academies, healthcare training programs, culinary institutes, trade/technical schools, and some traditional universities. Always use this terminology:
- "Starts" not "enrollments" (a "start" = student actually began attending)
- "Start rate" not "enrollment rate" or "yield rate"
- "Cost per start" not "cost per enrollment"
- "Programs" not "majors" or "degrees" (e.g., "HVAC Technology program," "Medical Assisting program")
- "Program area" not "department" (e.g., Skilled Trades, Health Sciences, Automotive, IT, Cosmetology)
- "Term" not "semester" (career schools run 8-16 week terms)
- "Admissions reps" not "counselors"
- "Instructors" not "professors" or "faculty"
- "Campus President" or "Director of Education" not "Dean"
- "Completion rate" or "program completion rate" not "graduation rate"
- "Program drops" not "course drop-offs"
- "Enrollment agreement signed" / "EA signed" not "tuition deposit"
- "Accepted" or "Packaged" (financial aid packaged) not "Admitted"
- Reference "attendance rate" as a key retention predictor
- Reference "VA benefits" and "WIA/WIOA funding" as financial aid categories where relevant
- Reference "practical training hours" (covers externships, clinicals, clinic floor hours, and practicums) as program milestones where relevant
- Reference "career services placement rate" as a regulated outcome metric where relevant
- Reference "speed to contact" and "contact rate" as admissions KPIs where relevant
Never reference: dormitories/housing, alumni giving, endowments, Greek life, athletics, research grants.

The user asked: "${userPrompt}"
Classified report type: ${intent.report_type}
Filters applied: ${JSON.stringify(intent.filters)}

REAL DATA CONTEXT:
${JSON.stringify(dataSummary, null, 2)}

Generate a comprehensive report. Return JSON only with this exact schema:
{
  "report_title": "string",
  "report_type": "${intent.report_type}",
  "summary": "2-3 sentence executive summary with actual numbers from the data",
  "data_sources": [{"name": "string", "badge": "CRM|SIS|External"}],
  "metrics": [
    {"label": "string", "value": "string or number", "change_pct": "string or null", "trend": "up|down|flat|null"}
  ],
  "chart": {
    "type": "bar|line|pie|doughnut|funnel|horizontalBar|combo",
    "title": "string",
    "labels": ["array of strings"],
    "datasets": [
      {"label": "string", "data": [numbers], "backgroundColor": "color or array", "type": "optional override for combo charts"}
    ]
  },
  "narrative_sections": [
    {"heading": "string", "body": "paragraph of analysis using real numbers", "source_badge": "CRM|SIS|External"}
  ],
  "recommended_actions": [
    {"action": "string", "priority": "high|medium|low", "rationale": "string based on the data"}
  ],
  "suggestive_prompts": ["3 related prompts the user should ask next, contextual to what they just asked"],
  "proactive_alert": {
    "severity": "warning|critical|info|null",
    "title": "string or null",
    "description": "string or null",
    "investigate_prompt": "string or null"
  }
}

RULES:
- Every number must come from the data context. If data is missing, say "Data unavailable" rather than guessing.
- Chart type should match the report type (funnel for admissions pipeline, bar for comparison, combo for ROI, horizontalBar for rankings)
- Suggestive prompts must be contextually related to the current report and use career school terminology
- Proactive alert should flag something concerning in the data (or null if nothing notable)
- Keep narrative sections to 2-4 sections max
- Each recommended action must cite specific data points
- Always use "starts" not "enrollments", "programs" not "majors", "admissions reps" not "counselors", "completion rate" not "graduation rate"`
      },
      { role: "user", content: userPrompt }
    ],
    response_format: { type: "json_object" }
  });

  return JSON.parse(response.choices[0].message.content);
}

/* =====================================================
   PROACTIVE INSIGHTS ENGINE
===================================================== */

async function generateProactiveInsights() {
  const insights = [];

  try {
    // Check 1: Stale leads (no activity in 21+ days)
    const allLeads = await fetchCRMLeads({});
    const now = new Date();
    const staleLeads = allLeads.filter(l => {
      const lastAct = l.ModifiedOn ? new Date(l.ModifiedOn) : null;
      return lastAct && (now - lastAct) / (1000 * 60 * 60 * 24) > 21;
    });

    if (staleLeads.length > 10) {
      const acceptedStale = staleLeads.filter(l =>
        l.ProspectStage === "Accepted"
      );
      insights.push({
        severity: acceptedStale.length > 5 ? "critical" : "warning",
        title: `${staleLeads.length} students haven't engaged in 21+ days`,
        description: acceptedStale.length > 0
          ? `${acceptedStale.length} are in Accepted stage — at high risk of melt.`
          : `Spread across multiple pipeline stages. Review admissions rep follow-up cadence.`,
        investigate_prompt: "Show me at-risk students with no activity in 21 days"
      });
    }

    // Check 2: Application Completed to Enrolled drop
    const funnel = buildFunnelData(allLeads);
    const completed = funnel["Application Completed"]?.count || 0;
    const enrolled = funnel["Enrolled"]?.count || 0;
    if (completed > 0 && enrolled > 0) {
      const yieldRate = (enrolled / completed) * 100;
      if (yieldRate < 70) {
        insights.push({
          severity: yieldRate < 50 ? "critical" : "warning",
          title: `Start rate at ${yieldRate.toFixed(0)}% — below target`,
          description: `Only ${enrolled} of ${completed} students with completed applications have started. ${completed - enrolled} are at risk of not starting.`,
          investigate_prompt: "Show me students with completed applications who haven't started"
        });
      }
    }

    // Check 3: Course drop rates (if Mavis is configured)
    if (MAVIS_TABLES.courses) {
      const courses = await fetchMavisTable(MAVIS_TABLES.courses);
      const courseStats = {};
      courses.forEach(row => {
        const code = row.course_code || "Unknown";
        if (!courseStats[code]) courseStats[code] = { total: 0, dropped: 0 };
        courseStats[code].total++;
        if (["Dropped", "Withdrawn"].includes(row.enrollment_status)) {
          courseStats[code].dropped++;
        }
      });

      const highDropCourses = Object.entries(courseStats)
        .filter(([_, s]) => s.total >= 5 && (s.dropped / s.total) > 0.2)
        .sort((a, b) => (b[1].dropped / b[1].total) - (a[1].dropped / a[1].total));

      if (highDropCourses.length > 0) {
        const [code, stats] = highDropCourses[0];
        const rate = ((stats.dropped / stats.total) * 100).toFixed(0);
        insights.push({
          severity: "warning",
          title: `${code} has a ${rate}% drop rate`,
          description: `${stats.dropped} of ${stats.total} students have dropped or withdrawn from this program. This is significantly above the institutional average.`,
          investigate_prompt: `Show me program drops for ${code}`
        });
      }
    }

    // Check 4: Low-performing admissions rep
    const counselorMetrics = buildCounselorMetrics(allLeads);
    const lowPerformers = Object.entries(counselorMetrics)
      .filter(([name, m]) => name !== "Unassigned" && m.total >= 10 && parseFloat(m.conversion_rate) < 15)
      .sort((a, b) => parseFloat(a[1].conversion_rate) - parseFloat(b[1].conversion_rate));

    if (lowPerformers.length > 0) {
      const [name, metrics] = lowPerformers[0];
      insights.push({
        severity: "info",
        title: `${name}: ${metrics.conversion_rate} conversion rate`,
        description: `${name} has ${metrics.total} assigned leads but only ${metrics.enrolled} started. Consider reviewing assignment load or providing coaching.`,
        investigate_prompt: `Show me admissions rep performance breakdown for ${name}`
      });
    }

  } catch (err) {
    console.error("❌ Proactive insights error:", err.message);
  }

  // Return top 2 most critical
  return insights
    .sort((a, b) => {
      const severity = { critical: 3, warning: 2, info: 1 };
      return (severity[b.severity] || 0) - (severity[a.severity] || 0);
    })
    .slice(0, 2);
}

/* =====================================================
   API ENDPOINTS
===================================================== */

// Main report generation pipeline
app.post("/api/report", async (req, res) => {
  const startTime = Date.now();
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    console.log(`\n🔍 Quill AI Report Request: "${prompt}"`);

    // Step 1: Classify intent
    console.log("  → Step 1: Classifying intent...");
    const intent = await classifyIntent(prompt);
    console.log(`  → Classified as: ${intent.report_type}`, intent.filters);

    // Step 2: Fetch & assemble data
    console.log("  → Step 2: Fetching data...");
    const dataContext = await assembleDataContext(intent.report_type, intent.filters);
    console.log(`  → Data assembled: ${dataContext.data_sources_used.map(s => s.name).join(", ")}`);

    // Step 3: Generate report
    console.log("  → Step 3: Generating report...");
    const report = await generateReport(prompt, intent, dataContext);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ✅ Report generated in ${elapsed}s`);

    return res.json({
      success: true,
      elapsed_seconds: parseFloat(elapsed),
      intent,
      report
    });
  } catch (err) {
    console.error("❌ Report generation error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
      fallback: {
        report_title: "Report Generation Failed",
        summary: `Unable to generate report for: "${prompt}". Please try rephrasing your question.`,
        metrics: [],
        chart: null,
        recommended_actions: [],
        suggestive_prompts: [
          "Show me the admissions funnel for Fall 2026",
          "Compare start rates across campuses",
          "Which lead sources have the best cost per start?"
        ]
      }
    });
  }
});

// Report types list (for UI reference)
app.get("/api/report-types", (req, res) => {
  res.json({ report_types: REPORT_TYPES });
});

// Proactive insights
app.get("/api/proactive-insights", async (req, res) => {
  try {
    const insights = await generateProactiveInsights();
    res.json({ insights });
  } catch (err) {
    console.error("❌ Proactive insights error:", err.message);
    res.json({ insights: [] });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    agent: "Quill AI — Prompt to Report",
    timestamp: new Date().toISOString(),
    data_sources: {
      crm: !!LS_ACCESS_KEY,
      mavis_students: !!MAVIS_TABLES.students,
      mavis_courses: !!MAVIS_TABLES.courses,
      mavis_financial: !!MAVIS_TABLES.financial_aid,
      external_marketing: MARKETING_CAMPAIGNS.length > 0,
    }
  });
});

/* =====================================================
   STATIC FILE SERVING (for the frontend UI)
===================================================== */
app.use(express.static("public"));

/* =====================================================
   SERVER
===================================================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n✦ Quill AI — Prompt-to-Report Agent`);
  console.log(`  Running on port ${PORT}`);
  console.log(`  CRM: ${LS_BASE_URL}`);
  console.log(`  Mavis Students: ${MAVIS_TABLES.students || "NOT CONFIGURED"}`);
  console.log(`  Mavis Courses: ${MAVIS_TABLES.courses || "NOT CONFIGURED"}`);
  console.log(`  Mavis Financial: ${MAVIS_TABLES.financial_aid || "NOT CONFIGURED"}`);
  console.log(`  Marketing Campaigns: ${MARKETING_CAMPAIGNS.length} loaded\n`);
});
