
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
require('dotenv').config();
const axios = require('axios');
const FormData = require("form-data");

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
    const BASE_URL = process.env.PUBLIC_BASE_URL || ''; // e.g. "https://smartassessbackend.onrender.com"
stream.on('finish', () => resolve(`${BASE_URL}/pdfs/${filename}`));

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

const multer = require("multer");
const upload = multer({ dest: "uploads/" }); // temp storage for uploaded files
const { spawn } = require("child_process");


async function convertPdfToImages(pdfPath, outputDir) {
  return new Promise((resolve, reject) => {
    const process = spawn("python", ["convert_pdf_pymupdf.py", pdfPath, outputDir]);

    let data = "";
    let error = "";

    process.stdout.on("data", (chunk) => {
      data += chunk.toString();
    });

    process.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        console.error("Python Error:", error || data);
        return reject(error || "PDF conversion failed");
      }
      try {
        const result = JSON.parse(data);
        if (result.success) resolve(result.pages);
        else reject(result.error || "Unknown error from Python");
      } catch (err) {
        reject("Invalid JSON output from Python: " + err.message);
      }
    });
  });
}


// app.post("/grade", upload.single("file"), async (req, res) => {
//   const { gradeLevel, intensity, submission } = req.body || {};
//   debugLog("🟢 Incoming Payload", {
//     gradeLevel,
//     intensity,
//     handwriting: req.body?.handwriting,
//     submission,
//     file: req.file?.originalname,
//   });

//   // ---------------- FILE MODE ----------------
//   if (req.file) {
//     try {
//       const headers = {
//         Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
//         "Content-Type": "application/json",
//         "OpenAI-Beta": "assistants=v2",
//       };

//       // Step 1: Upload file to OpenAI (as vision input for images)
//       const fileForm = new FormData();
//       fileForm.append("file", fs.createReadStream(req.file.path), req.file.originalname);
//       fileForm.append("purpose", "vision"); // ✅ Important for GPT-4o vision

//       const uploadResp = await axios.post("https://api.openai.com/v1/files", fileForm, {
//         headers: {
//           Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
//           ...fileForm.getHeaders(),
//         },
//       });

//       const fileId = uploadResp.data.id;
//       debugLog("📤 Uploaded File to OpenAI", fileId);

//       // Step 2: Create a new thread
//       const threadResp = await axios.post("https://api.openai.com/v1/threads", {}, { headers });
//       const threadId = threadResp.data.id;
//       debugLog("🧵 Created Thread", threadId);

//       // Step 3: Prepare rubric + message content
//       const rubricDetails = getAllDistinguishedComponents();
//       const condensedRubric = rubricDetails
//         .map((r) => `${r.code} (${r.criterion}) - ${r.component}`)
//         .join("\n");

//       const ext = path.extname(req.file.originalname).toLowerCase();
//       const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);

//       // ✅ Compose message correctly (no attachments!)
//       const messagePayload = {
//         role: "user",
//         content: [
//           {
//             type: "text",
//             text: `
// You are an expert educator and grading assistant.

// Grade Level: ${gradeLevel}
// Grading Intensity: ${intensity}
// Handwriting Mode: ${isImage ? "ON" : "OFF"}

// Use the following Rubric Components to evaluate the uploaded student submission.

// 🎯 Rubric Components:
// ${condensedRubric}

// 📝 Provide your evaluation in this format:

// ---
// **Grading Report**
// **Overall Score (out of 4)**
// **Rubric Coverage**: All components reviewed.
// ---
// **Component Analysis**
// (For each rubric code, provide Explanation, Evidence, Suggestions)
// ---
// **Feedback to Student**
// ---
// **Feedback to Teacher**
//             `,
//           },
//           isImage
//             ? {
//                 type: "image_file",
//                 image_file: { file_id: fileId }, // ✅ file uploaded with purpose: "vision"
//               }
//             : {
//                 type: "text",
//                 text: `Please grade the following text submission attached under file ID: ${fileId}`,
//               },
//         ],
//       };

//       // Step 4: Send message to thread
//       await axios.post(
//         `https://api.openai.com/v1/threads/${threadId}/messages`,
//         messagePayload,
//         { headers }
//       );

//       // Step 5: Run the assistant
//       const runResp = await axios.post(
//         `https://api.openai.com/v1/threads/${threadId}/runs`,
//         { assistant_id: process.env.OPENAI_ASSISTANT_ID },
//         { headers }
//       );

//       const runId = runResp.data.id;
//       debugLog("🏃 Run started", runId);

//       // Step 6: Poll until finished
//       let runStatus = "in_progress";
//       while (["in_progress", "queued"].includes(runStatus)) {
//         await new Promise((r) => setTimeout(r, 2000));
//         const check = await axios.get(
//           `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
//           { headers }
//         );
//         runStatus = check.data.status;
//         debugLog("⏳ Run status", runStatus);
//       }

//       if (runStatus !== "completed") {
//         return res.status(500).json({ error: "Assistant run failed." });
//       }

//       // Step 7: Retrieve assistant response
//       const messagesResp = await axios.get(
//         `https://api.openai.com/v1/threads/${threadId}/messages`,
//         { headers }
//       );
//       const messages = messagesResp.data.data;
//       const assistantReply =
//         messages.find((m) => m.role === "assistant")?.content?.[0]?.text?.value || "";

//       if (!assistantReply.trim()) {
//         return res.status(500).json({ error: "Assistant returned empty content." });
//       }

//       // Step 8: Generate PDF
//       const pdfFilename = `grading-${Date.now()}.pdf`;
//       const pdfUrl = await generatePDF(assistantReply, pdfFilename);

//       return res.json({ success: true, result: assistantReply, pdfUrl });
//     } catch (err) {
//       console.error("🔥 Error in file grading:", err.response?.data || err.message);
//       return res.status(500).json({ error: "File grading failed." });
//     }
//   }

//   // ---------------- TEXT MODE ----------------
//   if (!submission || !submission.trim()) {
//     return res.status(400).json({ error: "Assignment text is required." });
//   }

//   try {
//     const subject = await identifySubject(submission);
//     debugLog("📚 Identified Subject", subject);

//     const standardsData = loadStandardsFile(subject, gradeLevel);
//     const rubricDetails = getAllDistinguishedComponents();

//     let standardsText = "📭 No grade-level standards available. Using rubric only.";
//     if (standardsData && Array.isArray(standardsData.standards)) {
//       if (subject === "ELA") {
//         standardsText = standardsData.standards
//           .map((domain) => `📘 ${domain.domain}\n${domain.standards.map((item) => `- ${item}`).join("\n")}`)
//           .join("\n\n");
//       } else {
//         standardsText = standardsData.standards
//           .map(
//             (domain) =>
//               `📌 ${domain.domain} - ${domain.title}\n${domain.components
//                 .map((c) => `- ${c.code}: ${c.description}`)
//                 .join("\n")}`
//           )
//           .join("\n\n");
//       }
//     }

//     const condensedRubric = rubricDetails.map((r) => `${r.code} (${r.criterion}) - ${r.component}`).join("\n");

//     const prompt = `
// You are an expert educator and grading assistant.

// Grade Level: ${gradeLevel}
// Grading Intensity: ${intensity}
// Identified Subject: ${subject}
// Handwriting Mode: OFF

// Use the following Rubric Components and Grade-Level Standards to evaluate the student submission.

// 🎯 Rubric Components:
// ${condensedRubric}

// 📚 Grade-Level Standards:
// ${standardsText}

// ✍️ Student Submission:
// "${submission}"

// 📝 Provide your evaluation in this format:

// ---
// **Grading Report**
// **Overall Score (out of 4)**
// **Rubric Coverage**: All components reviewed.
// ---
// **Component Analysis**
// (For each rubric code, provide Explanation, Evidence, and Suggestions)
// ---
// **Feedback to Student**
// ---
// **Feedback to Teacher**
//     `.trim();

//     const headers = {
//       Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
//       "Content-Type": "application/json",
//     };

//     const aiResponse = await axios.post(
//       "https://openrouter.ai/api/v1/chat/completions",
//       {
//         model: "mistralai/mistral-7b-instruct:free",
//         messages: [
//           { role: "system", content: "You are an educational grading assistant." },
//           { role: "user", content: prompt },
//         ],
//       },
//       { headers }
//     );

//     let result = aiResponse.data.choices[0].message?.content || "";
//     debugLog("🧠 Raw Model Output", result);

//     if (!result.trim()) {
//       return res.status(500).json({ error: "Model returned empty content." });
//     }

//     const pdfFilename = `grading-${Date.now()}.pdf`;
//     const pdfUrl = await generatePDF(result, pdfFilename);

//     res.json({ success: true, result, pdfUrl });
//   } catch (err) {
//     console.error("🔥 Error during grading:", err);
//     res.status(500).json({ error: "Error processing grading with Mistral." });
//   }
// });
app.post("/grade", upload.single("file"), async (req, res) => {
  const { gradeLevel, intensity, submission } = req.body || {};
  console.log("🟢 Incoming Payload", {
    gradeLevel,
    intensity,
    submission,
    file: req.file?.originalname,
  });

  // ---------------- FILE MODE ----------------
  if (req.file) {
    try {
      const headers = {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      };

      const ext = path.extname(req.file.originalname).toLowerCase();
      const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
      const isPdf = ext === ".pdf";

      let uploadedFileIds = [];
      let outputDir = "";

      // ✅ Handle PDF uploads
      if (isPdf) {
        outputDir = path.join("uploads", `pdfpages-${Date.now()}`);
        const pages = await convertPdfToImages(req.file.path, outputDir);
        console.log(`📄 PDF converted into ${pages.length} pages`);

        for (const pagePath of pages) {
          const fileForm = new FormData();
          fileForm.append("file", fs.createReadStream(pagePath), path.basename(pagePath));
          fileForm.append("purpose", "vision");
          const uploadResp = await axios.post("https://api.openai.com/v1/files", fileForm, {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              ...fileForm.getHeaders(),
            },
          });
          uploadedFileIds.push(uploadResp.data.id);
        }
      } else {
        // ✅ Normal image upload
        const fileForm = new FormData();
        fileForm.append("file", fs.createReadStream(req.file.path), req.file.originalname);
        fileForm.append("purpose", "vision");
        const uploadResp = await axios.post("https://api.openai.com/v1/files", fileForm, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            ...fileForm.getHeaders(),
          },
        });
        uploadedFileIds = [uploadResp.data.id];
      }

      console.log("📤 Uploaded Files:", uploadedFileIds);

      // ✅ Create thread
      const threadResp = await axios.post("https://api.openai.com/v1/threads", {}, { headers });
      const threadId = threadResp.data.id;

      // ✅ Rubric and prompt
      const rubricDetails = getAllDistinguishedComponents();
      const condensedRubric = rubricDetails
        .map((r) => `${r.code} (${r.criterion}) - ${r.component}`)
        .join("\n");

      const messagePayload = {
        role: "user",
        content: [
          {
            type: "text",
            text: `
You are an expert educator and grading assistant.

Grade Level: ${gradeLevel}
Grading Intensity: ${intensity}
Handwriting Mode: ${isImage || isPdf ? "ON" : "OFF"}

Use the following Rubric Components to evaluate the uploaded student submission.

🎯 Rubric Components:
${condensedRubric}

📝 Provide your evaluation in this format:

---
**Grading Report**
**Overall Score (out of 4)**
**Rubric Coverage**: All components reviewed.
---
**Component Analysis**
(For each rubric code, provide Explanation, Evidence, Suggestions)
---
**Feedback to Student**
---
**Feedback to Teacher**
            `,
          },
          ...(isImage || isPdf
            ? uploadedFileIds.map((fid) => ({
                type: "image_file",
                image_file: { file_id: fid },
              }))
            : [
                {
                  type: "text",
                  text: `Please grade the following text submission attached under file ID: ${uploadedFileIds[0]}`,
                },
              ]),
        ],
      };

      // ✅ Send message
      await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, messagePayload, {
        headers,
      });

      // ✅ Run assistant
      const runResp = await axios.post(
        `https://api.openai.com/v1/threads/${threadId}/runs`,
        { assistant_id: process.env.OPENAI_ASSISTANT_ID },
        { headers }
      );
      const runId = runResp.data.id;

      // ✅ Poll until done
      let runStatus = "in_progress";
      while (["in_progress", "queued"].includes(runStatus)) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await axios.get(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
          { headers }
        );
        runStatus = check.data.status;
        console.log("⏳ Run status", runStatus);
      }

      if (runStatus !== "completed") {
        return res.status(500).json({ error: "Assistant run failed." });
      }

      // ✅ Retrieve response
      const messagesResp = await axios.get(
        `https://api.openai.com/v1/threads/${threadId}/messages`,
        { headers }
      );
      const messages = messagesResp.data.data;
      const assistantReply =
        messages.find((m) => m.role === "assistant")?.content?.[0]?.text?.value || "";

      if (!assistantReply.trim()) {
        return res.status(500).json({ error: "Assistant returned empty content." });
      }

      // ✅ Generate PDF
      const pdfFilename = `grading-${Date.now()}.pdf`;
      const pdfUrl = await generatePDF(assistantReply, pdfFilename);

      if (isPdf && outputDir) fs.rmSync(outputDir, { recursive: true, force: true });

      return res.json({ success: true, result: assistantReply, pdfUrl });
    } catch (err) {
      console.error("🔥 Error in file grading:", err.response?.data || err.message);
      return res.status(500).json({ error: "File grading failed." });
    }
  }

  // ---------------- TEXT MODE ----------------
  if (!submission || !submission.trim()) {
    return res.status(400).json({ error: "Assignment text is required." });
  }

  try {
    const subject = await identifySubject(submission);
    const standardsData = loadStandardsFile(subject, gradeLevel);
    const rubricDetails = getAllDistinguishedComponents();

    const condensedRubric = rubricDetails
      .map((r) => `${r.code} (${r.criterion}) - ${r.component}`)
      .join("\n");

    const prompt = `
You are an expert educator and grading assistant.

Grade Level: ${gradeLevel}
Grading Intensity: ${intensity}
Identified Subject: ${subject}
Handwriting Mode: OFF

Use the following Rubric Components and Grade-Level Standards to evaluate the student submission.

🎯 Rubric Components:
${condensedRubric}

✍️ Student Submission:
"${submission}"
    `.trim();

    const headers = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    };

    const aiResponse = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct:free",
        messages: [
          { role: "system", content: "You are an educational grading assistant." },
          { role: "user", content: prompt },
        ],
      },
      { headers }
    );

    const result = aiResponse.data.choices[0].message?.content || "";
    const pdfFilename = `grading-${Date.now()}.pdf`;
    const pdfUrl = await generatePDF(result, pdfFilename);

    res.json({ success: true, result, pdfUrl });
  } catch (err) {
    console.error("🔥 Error during grading:", err);
    res.status(500).json({ error: "Error processing grading with Mistral." });
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
