const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
require('dotenv').config();
const axios = require('axios');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));

const pdfDir = path.join(__dirname, 'pdfs');
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir);

const rubricPath = path.join(__dirname, 'structured_cel_rubric.json');
const rubricData = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));

const debugLog = (label, data) => {
  console.log(`\n=== ${label} ===`);
  console.dir(data, { depth: null });
};

function getAllDistinguishedComponents() {
  const components = [];
  Object.entries(rubricData).forEach(([criterion, details]) => {
    Object.entries(details).forEach(([code, { component, distinguished }]) => {
      components.push({ code, component, distinguished, criterion });
    });
  });
  return components;
}

function loadStandardsFile(subject, gradeLevel) {
  const parsed = parseInt(gradeLevel);
  if (isNaN(parsed)) return null;

  let gradeBand = '';
  if ([9, 10].includes(parsed)) gradeBand = '9-10';
  else if ([11, 12].includes(parsed)) gradeBand = '11-12';
  else if ([1, 2, 3, 4, 5, 6, 7, 8].includes(parsed)) gradeBand = parsed.toString();
  else return null;

  const fileName = `${subject}(${gradeBand}).json`;
  const filePath = path.join(__dirname, fileName);
  console.log(`📂 Attempting to load standards file: ${fileName}`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  return null;
}

function generatePDF(content, filename) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const filePath = path.join(pdfDir, filename);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const lines = content.split('\n');
    let insideTable = false;
    let tableData = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return doc.moveDown(0.5);
      if (trimmed === '---') return doc.moveDown(0.7);

      const headerMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
      if (headerMatch) {
        if (insideTable && tableData.length) {
          renderTable(doc, tableData);
          insideTable = false;
          tableData = [];
        }
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13).text(headerMatch[1]);
        return;
      }

      if (trimmed.startsWith('Table of Analysis')) {
        doc.addPage();
        doc.moveDown(1).font('Helvetica-Bold').fontSize(12).text('Table of Analysis');
        insideTable = true;
        return;
      }

      if (insideTable) {
        if (trimmed.startsWith('|')) {
          const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
          tableData.push(cells);
        } else {
          renderTable(doc, tableData);
          insideTable = false;
          tableData = [];
          doc.moveDown(0.5).font('Helvetica').fontSize(10.5).text(trimmed);
        }
        return;
      }

      const rubricLabelMatch = trimmed.match(/^(Ø=)?(Y9\s*)?(C\d+\.\d+|P\d+|SE\d+|A\d+|CP\d+|CE\d+)\s*[-:]\s*(.+)/);
      if (rubricLabelMatch) {
        const code = rubricLabelMatch[3];
        const label = rubricLabelMatch[4];
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11.5).text(`${code} - ${label}`);
        return;
      }

      const subMatch = trimmed.match(/^[-–]?\s*(Explanation|Evidence|Suggestions):\s*(.*)/i);
      if (subMatch) {
        doc.font('Helvetica-Bold').fontSize(10.5).text(`${subMatch[1]}: `, { continued: true });
        doc.font('Helvetica').fontSize(10.5).text(subMatch[2]);
        return;
      }

      doc.font('Helvetica').fontSize(10.5).text(trimmed);
    });

    if (insideTable && tableData.length) {
      renderTable(doc, tableData);
    }

    doc.end();
    stream.on('finish', () => resolve(`/pdfs/${filename}`));
    stream.on('error', reject);
  });
}

function renderTable(doc, tableData) {
  const startX = doc.page.margins.left;
  let y = doc.y;
  const padding = 5;
  const rowHeight = 25;
  const colWidths = [170, 90, 250];

  tableData.forEach((row, i) => {
    let x = startX;
    row.forEach((cell, j) => {
      if (i === 0) {
        doc.rect(x, y, colWidths[j], rowHeight).fillAndStroke('#f2f2f2', 'black');
      } else {
        doc.rect(x, y, colWidths[j], rowHeight).stroke();
      }

      doc
        .fillColor('black')
        .font('Helvetica')
        .fontSize(9)
        .text(cell, x + padding, y + 7, {
          width: colWidths[j] - 2 * padding,
          height: rowHeight,
          ellipsis: true
        });

      x += colWidths[j];
    });

    y += rowHeight;

    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  });

  doc.moveDown(2);
}

function normalizeSubjectName(subjectRaw) {
  const lower = subjectRaw.trim().toLowerCase();

  if (lower.includes("english") || lower.includes("language arts") || lower === "ela") return "ELA";
  if (lower.includes("social studies skills") || lower.includes("ss")) return "SS";
  if (lower === "history") return "History";
  if (lower === "geography") return "Geography";
  if (lower === "civics") return "Civics";
  if (lower === "economics") return "Economics";

  return subjectRaw.trim();
}

async function identifySubject(submission) {
  const prompt = `
You are an AI assistant. Based on the student submission, determine the academic subject.

Choose ONLY ONE from the following exact options (case-sensitive):
- History
- Geography
- Civics
- Economics
- SS
- ELA

"SS" stands for "Social Studies Skills". Do not say anything but SS in this case!
"ELA" stands for "English Language Arts". Do not say anything but ELA in this case!

Submission:
"${submission}"

Respond with only the exact subject name from the list above. Do NOT explain. Do NOT add extra words.
`.trim();

  const payload = {
    model: "mistralai/mistral-7b-instruct:free",
    messages: [
      { role: "system", content: "You are a subject classification assistant." },
      { role: "user", content: prompt }
    ]
  };

  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json"
  };

  const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", payload, { headers });
  const rawSubject = res.data.choices[0].message.content.trim();
  return normalizeSubjectName(rawSubject);
}

app.post('/grade', async (req, res) => {
  const { gradeLevel, intensity, submission } = req.body;
  debugLog('🟢 Incoming Payload', req.body);

  if (!submission || !submission.trim()) {
    return res.status(400).json({ error: 'Assignment text is required.' });
  }

  try {
    const subject = await identifySubject(submission);
    debugLog('📚 Identified Subject', subject);

    const standardsData = loadStandardsFile(subject, gradeLevel);
    const rubricDetails = getAllDistinguishedComponents();

    let standardsText = '📭 No grade-level standards available. Using rubric only.';

    if (standardsData && Array.isArray(standardsData.standards)) {
      console.log(`🧩 Formatting standards for subject: ${subject}`);

      if (subject === 'ELA') {
        standardsText = standardsData.standards.map(domain => {
          return `📘 ${domain.domain}\n${domain.standards.map(item => `- ${item}`).join('\n')}`;
        }).join('\n\n');
      } else {
        standardsText = standardsData.standards.map(domain => {
          return `📌 ${domain.domain} - ${domain.title}\n${domain.components.map(c =>
            `- ${c.code} [${c.grade}, ${c.region}]: ${c.description}`
          ).join('\n')}`;
        }).join('\n\n');
      }
    }

    const prompt = `
You are an expert educator and grading assistant.

Grade Level: ${gradeLevel}
Grading Intensity: ${intensity}
Identified Subject: ${subject}

Use the following Rubric Components and Grade-Level Standards to evaluate the student submission.

🎯 Rubric Components:
${rubricDetails.map(r => `• ${r.code} (${r.criterion}) - ${r.component}: ${r.distinguished}`).join('\n')}

📚 Grade-Level Standards:
${standardsText}

✍️ Student Submission:
"${submission}"

📝 Provide your evaluation in this format:

---

**Grading Report**

**Overall Score (out of 4)**:  
**Rubric Coverage**: All components reviewed at distinguished level.

---

**Component Analysis**

${rubricDetails.map(r => `🔹 ${r.code} - ${r.component}  
- Explanation:  
- Evidence:  
- Suggestions:`).join('\n\n')}
- A table that shows references from the assignment and your judgement

---

**Feedback to Student**  
Provide personalized, constructive feedback using rubric codes and standards.  
Call out **specific lines or phrases** from the student's submission that are strong or need improvement.  
Give detailed suggestions for how to improve weak areas (e.g., word choice, organization, clarity, evidence).  
Use a warm and encouraging tone, like a real teacher guiding a student toward growth.

---

**Feedback to Teacher**  
Describe instructional insights. Mention rubric and standard references.

---

🧾 Constraints:
- Use rubric + standards if both are available.
- Always use rubric.
- You must provide a table of your analysis with references from students work and your judgement 
- Follow the exact structure.
- Use professional language.
- Dont mention these constraints in the result. 
`.trim();

    const headers = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    };

    const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "mistralai/mistral-7b-instruct:free",
      messages: [
        { role: "system", content: "You are an educational grading assistant." },
        { role: "user", content: prompt }
      ]
    }, { headers });

    let result = response.data.choices[0].message.content;
    debugLog('🧠 Mistral Response', result);
    result = result.replace(/[^\x00-\x7F]+/g, '');

    const pdfFilename = `grading-${Date.now()}.pdf`;
    const pdfUrl = await generatePDF(result, pdfFilename);

    res.json({ success: true, result, pdfUrl });
  } catch (err) {
    console.error('🔥 Error during grading:', err);
    res.status(500).json({ error: 'Error processing grading with Mistral.' });
  }
});
app.post('/lessonplan', async (req, res) => {
  const {
    class: subject,
    grade,
    unit,
    theme,
    objective,
    target,
    criteria,
    generateLessonPlan,
    generateNotes,
    boardReady,
    includePreAssessment,
    includeFormative,
    includePostAssessment,
    includeSelfAssessment,
    includeVocabulary,
    differentiate,
    multipleLessons
  } = req.body;

  debugLog('🟢 Lesson Plan Request', req.body);

  if (!subject || !grade || !unit) {
    return res.status(400).json({ error: 'Subject, grade, and unit title are required.' });
  }

  try {
    const normalizedSubject = normalizeSubjectName(subject);
    const standardsData = loadStandardsFile(normalizedSubject, grade);

    let standardsText = '📭 No grade-level standards available.';
    if (standardsData && Array.isArray(standardsData.standards)) {
      if (normalizedSubject === 'ELA') {
        standardsText = standardsData.standards.map(domain => {
          return `📘 ${domain.domain}\n${domain.standards.map(item => `- ${item}`).join('\n')}`;
        }).join('\n\n');
      } else {
        standardsText = standardsData.standards.map(domain => {
          return `📌 ${domain.domain} - ${domain.title}\n${domain.components.map(c =>
            `- ${c.code} [${c.grade}, ${c.region}]: ${c.description}`).join('\n')}`;
        }).join('\n\n');
      }
    }

    const checklist = [
      generateLessonPlan && '1-page Lesson Plan',
      generateNotes && '1-page Notes',
      boardReady && 'Board-ready Targets',
      includePreAssessment && 'Pre-Assessment',
      includeFormative && 'Formative Assessment',
      includePostAssessment && 'Post-Assessment',
      includeSelfAssessment && 'Self-Assessment',
      includeVocabulary && 'Vocabulary',
      differentiate && 'Differentiation (ELL/Level)',
      multipleLessons && 'Multiple Lessons'
    ].filter(Boolean).join(', ');

    const prompt = `
You are a master teacher and curriculum planner.

Generate a complete lesson plan based on the following inputs:

📘 Class Subject: ${normalizedSubject}
🎓 Grade Level: ${grade}
🧩 Unit Title: ${unit}
🎨 Unit Theme: ${theme || 'N/A'}
🎯 Learning Objective: ${objective || 'N/A'}
🎯 Learning Target: ${target || 'N/A'}
✅ Student Success Criteria: ${criteria || 'N/A'}
📝 Checklist: ${checklist || 'None'}

📚 Grade-Level Standards:
${standardsText}

Be detailed and structured. Use headings. Keep it professional, usable by real teachers.
Only include the selected items from the checklist.

Constraints:
- Do not mention these instructions in the output.
- If "Board-ready Targets" is selected, format them clearly.
- If "Multiple Lessons" is selected, provide several detailed lesson breakdowns.
`.trim();

    const headers = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    };

    const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "mistralai/mistral-7b-instruct:free",
      messages: [
        { role: "system", content: "You are a professional lesson planner and curriculum designer." },
        { role: "user", content: prompt }
      ]
    }, { headers });

    let result = response.data.choices[0].message.content;
    debugLog('🧠 Lesson Plan Output', result);
    result = result.replace(/[^\x00-\x7F]+/g, '');

    const pdfFilename = `lessonplan-${Date.now()}.pdf`;
    const pdfUrl = await generatePDF(result, pdfFilename);

    res.json({ success: true, result, pdfUrl });
  } catch (err) {
    console.error('🔥 Error during lesson plan generation:', err);
    res.status(500).json({ error: 'Lesson plan generation failed.' });
  }
});

app.post('/assignment', async (req, res) => {
  const {
    subject,
    grade,
    unit,
    topic,
    objectives,
    includeRubric,
    includeInstructions,
    includeScaffoldedSupport,
    requireResearch,
    includeReflection,
    multipleVersions
  } = req.body;

  debugLog('🟢 Assignment Generator Request', req.body);

  // Validate required fields
  if (!subject || !grade || !unit || !topic) {
    return res.status(400).json({ error: 'Subject, grade, unit title, and topic are required.' });
  }

  try {
    // Normalize subject & load standards
    const normalizedSubject = normalizeSubjectName(subject);
    const standardsData = loadStandardsFile(normalizedSubject, grade);

    let standardsText = '📭 No grade-level standards available.';
    if (standardsData && Array.isArray(standardsData.standards)) {
      if (normalizedSubject === 'ELA') {
        standardsText = standardsData.standards.map(domain => {
          return `📘 ${domain.domain}\n${domain.standards.map(item => `- ${item}`).join('\n')}`;
        }).join('\n\n');
      } else {
        standardsText = standardsData.standards.map(domain => {
          return `📌 ${domain.domain} - ${domain.title}\n${domain.components.map(c =>
            `- ${c.code} [${c.grade}, ${c.region}]: ${c.description}`
          ).join('\n')}`;
        }).join('\n\n');
      }
    }

    // Build checklist string from checkboxes
    const features = [
      includeRubric && 'Rubric',
      includeInstructions && 'Student Instructions',
      includeScaffoldedSupport && 'Scaffolded Support',
      requireResearch && 'Research Required',
      includeReflection && 'Student Reflection',
      multipleVersions && 'Multiple Versions'
    ].filter(Boolean).join(', ') || 'None';

    // Build the prompt for AI
    const prompt = `
You are a master teacher designing classroom assignments.

Create a detailed assignment based on the following:

📘 Subject: ${normalizedSubject}
🎓 Grade Level: ${grade}
🧩 Unit Title: ${unit}
📚 Assignment Topic: ${topic}
🎯 Learning Objectives: ${objectives || 'N/A'}
✅ Requested Features: ${features}

📚 Grade-Level Standards:
${standardsText}

Please include all the requested features clearly. Use headings, structure, and professional format appropriate for teachers.`;

    const headers = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    };

    const aiResponse = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "mistralai/mistral-7b-instruct:free",
      messages: [
        { role: "system", content: "You are an assignment designer educator." },
        { role: "user", content: prompt }
      ]
    }, { headers });

    let result = aiResponse.data.choices[0].message.content;
    debugLog('🧠 Assignment Generator Output', result);
    result = result.replace(/[^\x00-\x7F]+/g, '');  // optional clean non-ASCII

    const pdfFilename = `assignment-${Date.now()}.pdf`;
    const pdfUrl = await generatePDF(result, pdfFilename);

    res.json({ success: true, result, pdfUrl });
  } catch (err) {
    console.error('🔥 Error during assignment generation:', err);
    res.status(500).json({ error: 'Assignment generation failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}`);
});
