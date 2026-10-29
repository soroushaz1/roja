// Makes the showcase's faces (faces.json) with an image model on Vertex AI, in the
// Google Cloud project the workflow signs in to. No real person: every face is made.
// Tries Imagen 4 first, then Gemini's image model, as Imagen's endpoints are being
// retired; says which one made each face.
//
//   ROJA_GCP_PROJECT=… GCP_TOKEN=$(gcloud auth print-access-token) node tools/showcase/make-faces.mjs
//
// A face already in tools/showcase/faces/ is kept: the same people across runs.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const {style,faces}=JSON.parse(fs.readFileSync(path.join(here,'faces.json'),'utf8'));
const project=process.env.ROJA_GCP_PROJECT,token=process.env.GCP_TOKEN,out=process.argv[2]||path.join(here,'faces');
if(!project||!token)throw new Error('ROJA_GCP_PROJECT and GCP_TOKEN are needed');
fs.mkdirSync(out,{recursive:true});

async function call(url,body){
  const res=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
  const text=await res.text();
  if(!res.ok)throw new Error(`${res.status} ${text.slice(0,300)}`);
  return JSON.parse(text);
}
const makers=[
  ['imagen-4.0-generate-001',async prompt=>{
    const r=await call(`https://us-central1-aiplatform.googleapis.com/v1/projects/${project}/locations/us-central1/publishers/google/models/imagen-4.0-generate-001:predict`,
      {instances:[{prompt}],parameters:{sampleCount:1,aspectRatio:'3:4',personGeneration:'allow_adult'}});
    return r.predictions?.[0]?.bytesBase64Encoded;
  }],
  ['gemini-2.5-flash-image',async prompt=>{
    const r=await call(`https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/gemini-2.5-flash-image:generateContent`,
      {contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:'3:4'}}});
    return r.candidates?.[0]?.content?.parts?.find(p=>p.inlineData)?.inlineData?.data;
  }]
];

const made=[];
for(const face of faces){
  if(fs.existsSync(path.join(out,`${face.id}.png`))){console.log(`${face.id}: kept`);made.push({id:face.id,model:'kept'});continue;}
  const prompt=`${style} ${face.prompt}`;
  let done=false;
  for(const [model,make] of makers){
    try{
      const data=await make(prompt);
      if(!data)throw new Error('no picture in the answer (filtered?)');
      fs.writeFileSync(path.join(out,`${face.id}.png`),Buffer.from(data,'base64'));
      console.log(`${face.id}: made by ${model}`);made.push({id:face.id,model});done=true;break;
    }catch(e){console.log(`${face.id}: ${model} failed: ${e.message}`);}
  }
  if(!done)console.log(`${face.id}: not made`);
}
if(!made.length)process.exit(1);
