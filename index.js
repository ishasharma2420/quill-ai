import express from "express";
import axios from "axios";
import OpenAI from "openai";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

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
  { campaign_name: "Nursing BSN — Google Ads", platform: "Google Ads", program: "Nursing BSN", spend: 48000, leads_generated: 156, cost_per_lead: 307.69, enrolled: 18, cost_per_enrolled: 2666.67, period: "Fall 2025" },
  { campaign_name: "MBA Program — Facebook", platform: "Facebook", program: "Business MBA", spend: 32000, leads_generated: 210, cost_per_lead: 152.38, enrolled: 31, cost_per_enrolled: 1032.26, period: "Fall 2025" },
  { campaign_name: "CS Program — Google Ads", platform: "Google Ads", program: "Computer Science BS", spend: 28000, leads_generated: 98, cost_per_lead: 285.71, enrolled: 12, cost_per_enrolled: 2333.33, period: "Fall 2025" },
  { campaign_name: "Education MEd — Email", platform: "Email Campaign", program: "Education MEd", spend: 5200, leads_generated: 87, cost_per_lead: 59.77, enrolled: 22, cost_per_enrolled: 236.36, period: "Fall 2025" },
  { campaign_name: "Psychology BA — Facebook", platform: "Facebook", program: "Psychology BA", spend: 15000, leads_generated: 134, cost_per_lead: 111.94, enrolled: 14, cost_per_enrolled: 1071.43, period: "Fall 2025" },
  { campaign_name: "Brand Awareness — Google Ads", platform: "Google Ads", program: "General", spend: 22000, leads_generated: 320, cost_per_lead: 68.75, enrolled: 0, cost_per_enrolled: null, period: "Fall 2025" },
  { campaign_name: "Open House Event — Organic", platform: "Organic", program: "General", spend: 3500, leads_generated: 45, cost_per_lead: 77.78, enrolled: 15, cost_per_enrolled: 233.33, period: "Spring 2026" },
  { campaign_name: "Nursing BSN — College Fair", platform: "College Fair", program: "Nursing BSN", spend: 8000, leads_generated: 62, cost_per_lead: 129.03, enrolled: 20, cost_per_enrolled: 400.00, period: "Spring 2026" },
];

// Placeholder for IPEDS / BLS if needed later
const IPEDS_BENCHMARKS = {}; // TBD
const LABOR_MARKET = {};     // TBD

/* =====================================================
   REPORT TYPE DEFINITIONS
===================================================== */

const REPORT_TYPES = [
  { id: "enrollment_funnel", name: "Enrollment Funnel", description: "Pipeline from Inquiry → Enrolled with conversion rates", data_sources: ["crm"] },
  { id: "campus_comparison", name: "Campus Comparison", description: "Side-by-side metrics across campuses", data_sources: ["crm"] },
  { id: "source_roi", name: "Source ROI Analysis", description: "Lead source performance and marketing cost-per-enrolled", data_sources: ["crm", "external"] },
  { id: "counselor_performance", name: "Counselor Performance", description: "Conversion rates and activity by counselor", data_sources: ["crm"] },
  { id: "program_performance", name: "Program Performance", description: "Enrollment, retention, and outcomes by academic program", data_sources: ["crm", "mavis"] },
  { id: "course_dropoff", name: "Course Drop-off Analysis", description: "Withdrawal and failure rates by course", data_sources: ["mavis"] },
  { id: "financial_overview", name: "Financial Overview", description: "Tuition balances and financial aid disbursement", data_sources: ["mavis"] },
  { id: "at_risk_students", name: "At-Risk Students", description: "Students with low engagement, stale activity, or academic issues", data_sources: ["crm", "mavis"] },
  { id: "marketing_performance", name: "Marketing Performance", description: "Campaign spend, CPL, and ROI by channel", data_sources: ["external"] },
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
        content: `You are a report intent classifier for a university admissions CRM. Given a user's natural language prompt, classify it into a report type and extract filters.

Available report types: ${REPORT_TYPES.map(r => `${r.id} (${r.name})`).join(", ")}

If the prompt doesn't clearly match any specific type, use "general".

Return JSON only:
{
  "report_type": "one of the report type IDs",
  "filters": {
    "campus": "Campus A" | "Campus B" | "Campus C" | "Online" | null,
    "program": "Nursing BSN" | "Business MBA" | "Computer Science BS" | "Education MEd" | "Psychology BA" | null,
    "term": "Fall 2025" | "Spring 2026" | "Summer 2026" | "Fall 2026" | null,
    "source": "Website" | "Google Ads" | "Facebook" | "Referral" | "College Fair" | "Email Campaign" | "Organic Search" | null,
    "counselor": "Sarah Chen" | "James Miller" | "Maria Rodriguez" | "David Kim" | "Lisa Thompson" | null,
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
async function fetchCRMLeads(filters = {}) {
  try {
    // Build search criteria
    const searchCriteria = [];

    if (filters.campus) {
      searchCriteria.push({
        Attribute: "mx_Campus",
        Condition: "eq",
        Value: filters.campus
      });
    }
    if (filters.program) {
      searchCriteria.push({
        Attribute: "mx_Program_Interest",
        Condition: "eq",
        Value: filters.program
      });
    }
    if (filters.source) {
      searchCriteria.push({
        Attribute: "Source",
        Condition: "eq",
        Value: filters.source
      });
    }
    if (filters.term) {
      searchCriteria.push({
        Attribute: "mx_Intended_Intake_Term",
        Condition: "eq",
        Value: filters.term
      });
    }
    if (filters.counselor) {
      searchCriteria.push({
        Attribute: "OwnerId",
        Condition: "eq",
        Value: filters.counselor
      });
    }

    const allLeads = [];
    let pageIndex = 1;
    const pageSize = 200;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.post(
        `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
        {
          Parameter: searchCriteria.length > 0
            ? { LookupName: searchCriteria[0].Attribute, LookupValue: searchCriteria[0].Value, SqlOperator: "=" }
            : { LookupName: "ProspectStage", LookupValue: "", SqlOperator: "ne" },
          Columns: {
            Include_CSV: [
              "ProspectID", "FirstName", "LastName", "EmailAddress",
              "ProspectStage", "Source", "CreatedOn", "ModifiedOn",
              "EngagementScore", "Score",
              "mx_Campus", "mx_Program_Interest", "mx_Program_Level",
              "OwnerId", "mx_Intended_Intake_Term",
              "mx_Application_Submitted", "mx_Financial_Aid_Status",
              "mx_GPA_Range", "mx_Enrollment_Deposit_Paid",
              "mx_Readiness_Score", "mx_Readiness_Bucket",
              "mx_Engagement_Readiness", "mx_Stage_Entered_On",
              "mx_Offer_Given_Date", "mx_Gender", "mx_US_States",
              "mx_Preferred_Language"
            ].join(",")
          },
          Sorting: { ColumnName: "CreatedOn", Direction: "1" },
          Paging: { PageIndex: pageIndex, PageSize: pageSize }
        },
        {
          params: { accessKey: LS_ACCESS_KEY, secretKey: LS_SECRET_KEY },
          headers: { "Content-Type": "application/json" }
        }
      );

      const leads = Array.isArray(response.data) ? response.data : [];

      // Flatten LeadPropertyList into flat objects
      const flattened = leads.map(lead => {
        const props = {};
        if (lead.LeadPropertyList) {
          lead.LeadPropertyList.forEach(p => { props[p.Attribute] = p.Value; });
        }
        return { ...lead, ...props };
      });

      allLeads.push(...flattened);

      if (leads.length < pageSize) {
        hasMore = false;
      } else {
        pageIndex++;
        if (pageIndex > 10) hasMore = false; // Safety cap
      }
    }

    console.log(`📋 CRM: Fetched ${allLeads.length} leads`);

    // Apply additional filters in-memory (since LSQ Leads.Get only supports single lookup)
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
    "Engagement Initiated", "Application Pending", "Application Completed",
    "Inquiry", "Application Started", "Application Submitted",
    "Accepted", "Enrolled", "Withdrawn"
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
    // Accepted but no deposit
    const stage = lead.ProspectStage;
    if (stage === "Accepted" && lead.mx_Enrollment_Deposit_Paid !== "Yes") {
      reasons.push("Accepted but deposit not paid");
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
        content: `You are Quill AI, an enterprise reporting intelligence agent for a university admissions office.
You generate data-driven reports based on REAL data provided to you. Never fabricate numbers — use only the data context given.

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
- Chart type should match the report type (funnel for enrollment, bar for comparison, combo for ROI, horizontalBar for rankings)
- Suggestive prompts must be contextually related to the current report
- Proactive alert should flag something concerning in the data (or null if nothing notable)
- Keep narrative sections to 2-4 sections max
- Each recommended action must cite specific data points`
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
          : `Spread across multiple pipeline stages. Review counselor follow-up cadence.`,
        investigate_prompt: "Show me at-risk students with no activity in 21 days"
      });
    }

    // Check 2: Acceptance-to-enrollment drop
    const funnel = buildFunnelData(allLeads);
    const accepted = funnel["Accepted"]?.count || 0;
    const enrolled = funnel["Enrolled"]?.count || 0;
    if (accepted > 0 && enrolled > 0) {
      const yieldRate = (enrolled / accepted) * 100;
      if (yieldRate < 70) {
        insights.push({
          severity: yieldRate < 50 ? "critical" : "warning",
          title: `Yield rate at ${yieldRate.toFixed(0)}% — below target`,
          description: `Only ${enrolled} of ${accepted} accepted students have enrolled. ${accepted - enrolled} students are at risk of not converting.`,
          investigate_prompt: "Show me accepted students who haven't enrolled yet"
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
          description: `${stats.dropped} of ${stats.total} students have dropped or withdrawn. This is significantly above the institutional average.`,
          investigate_prompt: `Show me student drop-offs for ${code}`
        });
      }
    }

    // Check 4: Low-performing counselor
    const counselorMetrics = buildCounselorMetrics(allLeads);
    const lowPerformers = Object.entries(counselorMetrics)
      .filter(([name, m]) => name !== "Unassigned" && m.total >= 10 && parseFloat(m.conversion_rate) < 15)
      .sort((a, b) => parseFloat(a[1].conversion_rate) - parseFloat(b[1].conversion_rate));

    if (lowPerformers.length > 0) {
      const [name, metrics] = lowPerformers[0];
      insights.push({
        severity: "info",
        title: `${name}: ${metrics.conversion_rate} conversion rate`,
        description: `${name} has ${metrics.total} assigned leads but only ${metrics.enrolled} enrolled. Consider reviewing assignment load or providing coaching.`,
        investigate_prompt: `Show me counselor performance breakdown for ${name}`
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
          "Show me the enrollment funnel for Fall 2026",
          "Compare conversion rates across campuses",
          "Which lead sources have the best ROI?"
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
