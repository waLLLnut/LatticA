use anchor_lang::prelude::*;

declare_id!("FYVh8n6CBbr6nm6P98wDxcWMNYAVHZRcEdR62XG9uBCu");

#[program]
pub mod lattica_coprocessor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
