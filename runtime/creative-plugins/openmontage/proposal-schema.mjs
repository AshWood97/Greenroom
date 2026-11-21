// Fields explicitly required by the pinned animation/character pipeline gates.
// Retain strict objects; do not permit arbitrary model-produced properties.
export function alignProposalSchema(schema) {
  const text = {type:'string',minLength:1};
  const animationMode={type:'string',enum:['image_animation','clip_video','manim','remotion_dataviz','diagram_stills','mixed']};
  const reuse = {type:'object',required:['recurring_motifs','layout_system','transition_family','typography_hierarchy','estimated_unique_scenes','estimated_reusable_templates'],properties:{
    recurring_motifs:{type:'array',items:text,minItems:1},layout_system:text,transition_family:text,
    typography_hierarchy:{type:'array',items:text,minItems:1},estimated_unique_scenes:{type:'integer',minimum:0},estimated_reusable_templates:{type:'integer',minimum:0},
  },additionalProperties:false};
  const selected=schema.properties.selected_concept.properties;
  Object.assign(selected,{animation_mode:animationMode,reuse_strategy:reuse,
    audio_architecture:{type:'string',enum:['single_narrator','character_dialogue','narrator_plus_characters','no_dialogue']},
    character_count:{type:'integer',minimum:1},rig_complexity:text,
    render_runtime:structuredClone(schema.properties.production_plan.properties.render_runtime)});
  Object.assign(schema.properties.production_plan.properties,{animation_mode:animationMode,reuse_strategy:reuse});
  schema.properties.cost_estimate.properties.provider_comparison={type:'array',minItems:2,items:{type:'object',required:['provider','available','estimated_usd','scope','limitations'],properties:{provider:text,available:{type:'boolean'},estimated_usd:{type:['number','null'],minimum:0},scope:text,limitations:text},additionalProperties:false}};
  return schema;
}
